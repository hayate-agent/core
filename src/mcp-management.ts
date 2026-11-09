import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ProjectTrustStore, type McpServerConfig, type McpServerEntry } from "@earendil-works/pi-coding-agent";
import { writeFileDurable } from "./durable.js";
import type { PluginUI } from "./plugins.js";
import { piMcpManagementAdapter, type McpConnection, type McpCredentials, type McpManagementAdapter } from "./runtime/pi-mcp-management.js";

export class McpUserError extends Error {}

export interface McpOperator {
  /** Authenticated channel/sender/conversation tuple, never supplied by the model. */
  owner: string;
  cwd: string;
  notify(text: string): void;
  ui?: PluginUI;
}
interface Login {
  id: string; name: string; owner: string; controller: AbortController;
  state: "starting" | "waiting" | "complete" | "failed" | "cancelled";
  finishRedirect?: (url: string | undefined) => void;
  connection?: McpConnection;
  finished: Promise<void>;
  fingerprint: string;
}
const HELP = `MCP management (no model turn):
/mcp — status, or interactive manager in the local TUI
/mcp add <name> <http-url> | -- <executable> [quoted args] | <JSON server configuration>
/mcp edit <name> <JSON server configuration>
/mcp remove <name>
/mcp connect|reconnect|disconnect <name>
/mcp enable|disable [name] — all MCP or one server
/mcp tools <name>
/mcp exposure <name> direct|codemode|deferred|hidden
/mcp login|logout <name>
/mcp auth <login-id> <browser-redirect-url>
/mcp cancel <login-id>
/mcp help
HTTP and stdio are supported. Use environment references for credentials, not chat messages.`;

/** Quote-aware argument parsing, not shell evaluation or environment expansion. */
export function mcpArguments(text: string): string[] {
  const words: string[] = []; let word = "", quote = "", escaped = false, started = false;
  for (const char of text) {
    if (escaped) { word += char; escaped = false; started = true; }
    else if (char === "\\" && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ""; else word += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ""; started = false; } }
    else { word += char; started = true; }
  }
  if (quote || escaped) throw new McpUserError("Unclosed quote or escape in MCP arguments");
  if (started) words.push(word);
  return words;
}

/** User-facing control plane. Secrets/configuration never pass through an LLM. */
export class McpManagement {
  private adapter?: McpManagementAdapter;
  private credentials?: McpCredentials;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly logins = new Map<string, Login>();
  private stopping = false;
  constructor(private readonly opts: {
    agentDir: string;
    enabled(): boolean;
    setEnabled(enabled: boolean): Promise<void>;
    changed(): Promise<void>;
    adapter?: McpManagementAdapter;
    providerToken?: (provider: string) => Promise<string | undefined>;
    loginTimeoutMs?: number;
  }) { this.adapter = opts.adapter; }

  private async sdk() {
    this.adapter ??= await piMcpManagementAdapter();
    this.credentials ??= this.adapter.credentials(this.opts.agentDir);
    return this.adapter;
  }
  private async entries(cwd: string) {
    const sdk = await this.sdk();
    const trusted = new ProjectTrustStore(this.opts.agentDir).get(cwd) === true;
    const loaded = sdk.load(this.opts.agentDir, cwd, trusted);
    if (loaded.errors.length) throw new McpUserError("MCP configuration is invalid; repair mcp.json (values withheld)");
    return loaded.servers;
  }
  private async entry(name: string, cwd: string) {
    const entry = (await this.entries(cwd)).find(e => e.name === name);
    if (!entry) throw new McpUserError("MCP server not found");
    return entry;
  }
  private async mutate(name: string, cwd: string, change: (old: unknown, sdk: McpManagementAdapter) => unknown, add = false) {
    const next = this.writes.catch(() => {}).then(async () => {
      const sdk = await this.sdk();
      if (typeof sdk.validate(name, { url: "https://example.invalid/mcp" }) === "string") throw new McpUserError("Invalid MCP server name");
      const configured = await this.entries(cwd);
      const existing = configured.find(e => e.name === name);
      if (add && !existing && configured.some(e => e.name.replaceAll("-", "_") === name.replaceAll("-", "_"))) throw new McpUserError("MCP server name collides with an existing server");
      if (!existing && !add) throw new McpUserError("MCP server not found");
      if (existing?.scope === "extension") throw new McpUserError("This server is registered by an extension; change that extension's configuration");
      const file = existing?.override ?? existing?.source ?? path.join(this.opts.agentDir, "mcp.json");
      let before: string | undefined;
      try { before = await readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Cannot read MCP configuration"); }
      if (before && before.length > 1024 * 1024) throw Error("MCP configuration exceeds 1 MiB");
      let document: Record<string, unknown>;
      try { document = before ? JSON.parse(before) : {}; } catch { throw Error("MCP configuration is invalid"); }
      if (!document || Array.isArray(document) || typeof document !== "object") throw Error("MCP configuration must be an object");
      const servers = document.mcpServers ?? {};
      if (!servers || Array.isArray(servers) || typeof servers !== "object") throw Error("Invalid MCP server map");
      const value = change(Object.hasOwn(servers, name) ? (servers as Record<string, unknown>)[name] : undefined, sdk);
      const entries = Object.entries(servers).filter(([key]) => key !== name);
      if (value !== undefined) entries.push([name, value]);
      document.mcpServers = Object.fromEntries(entries);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      let current: string | undefined;
      try { current = await readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Cannot recheck MCP configuration"); }
      if (current !== before) throw new McpUserError("MCP configuration changed concurrently; retry");
      await writeFileDurable(file, JSON.stringify(document, null, 2) + "\n", 0o600);
      for (const flow of this.logins.values()) if (flow.name === name && ["starting", "waiting"].includes(flow.state)) this.abortLogin(flow);
      await this.opts.changed();
    });
    this.writes = next;
    return next;
  }
  private async connection(entry: McpServerEntry, cwd: string) {
    const sdk = await this.sdk();
    return sdk.connect(entry, cwd, this.credentials!, this.opts.providerToken);
  }
  private async status(name: string | undefined, op: McpOperator, tools = false): Promise<string> {
    const entries = name ? [await this.entry(name, op.cwd)] : await this.entries(op.cwd);
    const rows: string[] = [`MCP: ${this.opts.enabled() ? "enabled" : "disabled"}`];
    for (const entry of entries) {
      if (!this.opts.enabled() || entry.config.enabled === false) { rows.push(`${entry.name}: disabled (${entry.config.exposure ?? "codemode"})`); continue; }
      const c = await this.connection(entry, op.cwd);
      try {
        try { await c.getClient(); } catch { /* State, never raw provider errors/credentials. */ }
        rows.push(`${entry.name}: ${c.state}; ${c.tools.length} tools; ${entry.config.exposure ?? "codemode"}; ${entry.scope ?? "configured"}`);
        if (tools) rows.push(...c.tools.map(t => `  ${t.name}`));
      } finally { await c.close(); }
    }
    if (!entries.length) rows.push("No MCP servers configured. /mcp add <name> <url>");
    const flows = [...this.logins.values()].filter(f => f.owner === op.owner);
    rows.push(...flows.map(f => `Login ${f.id} (${f.name}): ${f.state}`));
    return rows.join("\n");
  }
  private abortLogin(flow: Login): void {
    flow.controller.abort();
    void flow.connection?.close().catch(() => {});
  }
  private async beginLogin(name: string, op: McpOperator): Promise<string> {
    const entry = await this.entry(name, op.cwd);
    if (!this.opts.enabled() || entry.config.enabled === false) throw new McpUserError("Enable this MCP server before signing in");
    const active = [...this.logins.values()].find(f => f.name === name && ["starting", "waiting"].includes(f.state));
    if (active) return active.owner === op.owner ? `Login ${active.id}: ${active.state}` : "A sign-in for this server is already in progress";
    // Bounded metadata retention; never evict an active authorization.
    for (const [id, flow] of this.logins) if (!["starting", "waiting"].includes(flow.state)) this.logins.delete(id);
    if (this.logins.size >= 16) throw new McpUserError("Too many active MCP sign-ins");
    const flow: Login = { id: randomUUID(), name, owner: op.owner, controller: new AbortController(),
      state: "starting", finished: Promise.resolve(), fingerprint: JSON.stringify(entry) };
    this.logins.set(flow.id, flow);
    const timeout = setTimeout(() => this.abortLogin(flow), this.opts.loginTimeoutMs ?? 300000); timeout.unref();
    const notify = (text: string) => { try { op.notify(text); } catch { flow.controller.abort(); } };
    flow.finished = (async () => {
      const sdk = await this.sdk();
      const c = await this.connection(entry, op.cwd); flow.connection = c;
      try {
        if (flow.controller.signal.aborted) throw Error("Cancelled");
        try { await c.getClient(); } catch { /* Auth challenge is held by SDK. */ }
        if (flow.controller.signal.aborted) throw Error("Cancelled");
        if (!c.oauthUrl) throw Error("This server uses configured credentials rather than OAuth");
        if (c.state !== "connected") {
          if (c.state !== "needs-auth") throw Error("Server did not request OAuth");
          await sdk.login({ serverUrl: c.oauthUrl, store: this.credentials!.forServer(name, c.oauthUrl),
            settings: c.oauthSettings(), challenge: c.challenge, signal: flow.controller.signal,
            prompt: {
              showAuthorizationUrl: url => {
                flow.state = "waiting";
                notify(`MCP sign-in: ${name}\n${url.href}\nLogin: ${flow.id}\nApprove in your browser. If its callback cannot reach this agent, send /mcp auth ${flow.id} <redirect-url>. /mcp cancel ${flow.id} cancels.`);
              },
              promptForRedirectUrl: signal => new Promise(resolve => {
                if (signal.aborted) { resolve(undefined); return; }
                const abort = () => { flow.finishRedirect = undefined; resolve(undefined); };
                signal.addEventListener("abort", abort, { once: true });
                flow.finishRedirect = url => { signal.removeEventListener("abort", abort); flow.finishRedirect = undefined; resolve(url); };
              }),
            } });
          if (flow.controller.signal.aborted || JSON.stringify(await this.entry(name, op.cwd)) !== flow.fingerprint) throw Error("Cancelled or changed server");
          await c.reconnect();
        }
        if (flow.controller.signal.aborted || this.stopping) throw Error("Cancelled");
        flow.state = "complete";
        await this.opts.changed();
        notify(`MCP ${name}: signed in; ${c.tools.length} tools. Login ${flow.id}: complete.`);
      } catch {
        flow.state = flow.controller.signal.aborted ? "cancelled" : "failed";
        notify(`MCP ${name}: sign-in ${flow.state}. Login ${flow.id}. No credential or callback details are echoed.`);
      } finally { clearTimeout(timeout); flow.finishRedirect?.(undefined); await c.close(); }
    })().catch(() => { clearTimeout(timeout); flow.state = flow.controller.signal.aborted ? "cancelled" : "failed"; notify(`MCP ${name}: sign-in ${flow.state}.`); });
    return `MCP ${name}: sign-in started. Login ${flow.id}. Authorization link and result will appear here.`;
  }
  async execute(args: string, op: McpOperator): Promise<string> {
    if (this.stopping) throw new McpUserError("MCP management is shutting down");
    const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(args.trim());
    const action = match?.[1] ?? "status", name = match?.[2], rest = match?.[3];
    if (action === "help") return HELP;
    if (action === "status" || action === "list" || action === "tools") {
      if (rest || (action === "tools" && !name)) throw Error("Use /mcp status [name] or /mcp tools <name>");
      return this.status(name, op, action === "tools");
    }
    if (action === "auth" || action === "cancel") {
      const flow = name ? this.logins.get(name) : undefined;
      if (!flow || flow.owner !== op.owner) throw new McpUserError("MCP login not found for this operator and conversation");
      if (!["starting", "waiting"].includes(flow.state)) throw new McpUserError("MCP login is no longer pending");
      if (action === "cancel") { if (rest) throw Error("Use /mcp cancel <login-id>"); this.abortLogin(flow); return "MCP sign-in cancellation requested"; }
      if (!rest || rest.length > 8192 || !flow.finishRedirect) throw new McpUserError("MCP login is not waiting for a browser redirect");
      let url: URL; try { url = new URL(rest); } catch { throw new McpUserError("Invalid redirect URL"); }
      if (!/^(https?:)$/.test(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new McpUserError("Expected the browser's loopback redirect URL");
      if (JSON.stringify(await this.entry(flow.name, op.cwd)) !== flow.fingerprint) { flow.controller.abort(); throw new McpUserError("Server configuration changed; start sign-in again"); }
      flow.finishRedirect(rest);
      return "MCP browser redirect received; sign-in result will appear here";
    }
    if ((action === "enable" || action === "disable") && !name) {
      if (rest) throw Error("Use /mcp enable|disable [name]");
      if (action === "disable") for (const flow of this.logins.values()) this.abortLogin(flow);
      await this.opts.setEnabled(action === "enable"); await this.opts.changed();
      return `MCP ${action === "enable" ? "enabled" : "disabled"}; session connections update at the next turn boundary`;
    }
    if (!name) throw new McpUserError(HELP);
    if (action === "add" || action === "edit") {
      if (!rest) throw Error("Use /mcp add|edit <name> <url or JSON configuration>");
      let raw: unknown;
      try {
        if (rest.startsWith("-- ")) { const [command, ...args] = mcpArguments(rest.slice(3)); raw = { command, args }; }
        else if (rest.startsWith("--url ")) raw = { url: rest.slice(6).trim() };
        else raw = /^https?:\/\//.test(rest) ? { url: rest } : JSON.parse(rest);
      } catch { throw new McpUserError("Invalid MCP server configuration (values withheld)"); }
      const sdk = await this.sdk(), value = sdk.validate(name, raw);
      if (typeof value === "string") throw Error("Invalid MCP server configuration (values withheld)");
      await this.mutate(name, op.cwd, old => { if (action === "add" && old !== undefined) throw new McpUserError("Server already exists; use /mcp edit"); return value; }, action === "add");
      if (value.enabled !== false) await this.opts.setEnabled(true);
      await this.opts.changed();
      return `MCP ${name}: configuration saved; ${value.enabled === false ? "disabled" : "enabled"}. /mcp status ${name}; /mcp login ${name} for OAuth.`;
    }
    if (action === "remove") { if (rest) throw Error("Use /mcp remove <name>"); await this.mutate(name, op.cwd, () => undefined); return `MCP ${name}: removed`; }
    if (["enable", "disable", "connect", "reconnect", "disconnect"].includes(action)) {
      if (rest) throw Error("Unexpected MCP arguments");
      const enabled = !["disable", "disconnect"].includes(action);
      await this.mutate(name, op.cwd, old => ({ ...(old as object), enabled }));
      if (enabled) { await this.opts.setEnabled(true); await this.opts.changed(); return this.status(name, op); }
      return `MCP ${name}: disabled; existing session connections close at their next turn boundary`;
    }
    if (action === "exposure") {
      if (!["direct", "codemode", "deferred", "hidden"].includes(rest ?? "")) throw Error("Use /mcp exposure <name> direct|codemode|deferred|hidden");
      await this.mutate(name, op.cwd, old => ({ ...(old as object), exposure: rest })); return `MCP ${name}: exposure ${rest}`;
    }
    if (action === "login") { if (rest) throw Error("Use /mcp login <name>"); return this.beginLogin(name, op); }
    if (action === "logout") {
      if (rest) throw Error("Use /mcp logout <name>");
      const entry = await this.entry(name, op.cwd), c = await this.connection(entry, op.cwd);
      try {
        if (!c.oauthUrl) throw Error("This server uses configured credentials rather than OAuth");
        for (const flow of this.logins.values()) if (flow.name === name) this.abortLogin(flow);
        await Promise.all([...this.logins.values()].filter(f => f.name === name).map(f => f.finished));
        this.credentials!.remove(name, c.oauthUrl); await this.opts.changed();
      } finally { await c.close(); }
      return `MCP ${name}: signed out`;
    }
    throw new McpUserError(HELP);
  }
  async menu(op: McpOperator): Promise<string> {
    const ui = op.ui;
    if (!ui) return (await this.status(undefined, op)) + "\n\n" + HELP;
    const entries = await this.entries(op.cwd);
    const name = await ui.select("MCP servers", [...entries.map(e => ({ id: e.name, label: `${e.name} (${e.config.enabled === false ? "disabled" : "enabled"})` })), { id: "+add", label: "Add server" }, { id: "+help", label: "Help" }]);
    if (!name) return "MCP management cancelled";
    if (name === "+help") return HELP;
    if (name === "+add") {
      const server = await ui.prompt("Server name");
      if (!server) return "MCP management cancelled";
      const transport = await ui.select("MCP transport", [{ id: "http", label: "HTTP / OAuth" }, { id: "stdio", label: "Local executable (stdio)" }]);
      if (!transport) return "MCP management cancelled";
      let config: Record<string, unknown>;
      if (transport === "stdio") {
        const command = await ui.prompt("Executable (not a shell command)"), args = await ui.prompt("Arguments (quote arguments containing spaces; may be empty)");
        if (!command) return "MCP management cancelled";
        config = { command, args: mcpArguments(args) };
      } else {
        const url = await ui.prompt("MCP HTTP endpoint URL");
        if (!url) return "MCP management cancelled";
        config = { url };
      }
      return this.execute(`add ${server} ${JSON.stringify(config)}`, op);
    }
    const action = await ui.select(name, ["status", "tools", "connect", "disconnect", "login", "logout", "edit", "remove", "exposure"].map(id => ({ id, label: id })));
    if (!action) return "MCP management cancelled";
    if (action === "remove" && !(await ui.confirm(`Remove MCP ${name}?`))) return "MCP management cancelled";
    let value = "";
    if (action === "edit") value = await ui.prompt("Replacement server JSON (credentials: environment references)");
    if (action === "exposure") value = await ui.select("Tool exposure", ["direct", "codemode", "deferred", "hidden"].map(id => ({ id, label: id })));
    if (["edit", "exposure"].includes(action) && !value) return "MCP management cancelled";
    return this.execute(`${action} ${name}${value ? " " + value : ""}`, op);
  }
  async close(): Promise<void> {
    this.stopping = true;
    for (const flow of this.logins.values()) this.abortLogin(flow);
    await Promise.allSettled([...this.logins.values()].map(f => f.finished));
  }
}
