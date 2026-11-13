import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ProjectTrustStore, type McpServerConfig, type McpServerEntry } from "@earendil-works/pi-coding-agent";
import { message, type MessageKey } from "./language.js";
import { writeFileDurable } from "./durable.js";
import type { PluginUI } from "./plugins.js";
import { piMcpManagementAdapter, type McpConnection, type McpCredentials, type McpManagementAdapter } from "./runtime/pi-mcp-management.js";

export class McpUserError extends Error {
  constructor(public readonly key: MessageKey, locale = "en") { super(message(locale, key)); }
}

export interface McpOperator {
  /** Authenticated channel/sender/conversation tuple, never supplied by the model. */
  owner: string;
  cwd: string;
  /** Resolved by the command caller and captured for the operation. */
  language?: string;
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
function localizeError(error: unknown, locale: string): never {
  if (error instanceof McpUserError) throw new McpUserError(error.key, locale);
  throw error;
}

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
  if (quote || escaped) throw new McpUserError("mcp.unclosedQuote");
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
    if (loaded.errors.length) throw new McpUserError("mcp.configInvalid");
    return loaded.servers;
  }
  private async entry(name: string, cwd: string) {
    const entry = (await this.entries(cwd)).find(e => e.name === name);
    if (!entry) throw new McpUserError("mcp.notFound");
    return entry;
  }
  private async mutate(name: string, cwd: string, change: (old: unknown, sdk: McpManagementAdapter) => unknown, add = false) {
    const next = this.writes.catch(() => {}).then(async () => {
      const sdk = await this.sdk();
      if (typeof sdk.validate(name, { url: "https://example.invalid/mcp" }) === "string") throw new McpUserError("mcp.invalidName");
      const configured = await this.entries(cwd);
      const existing = configured.find(e => e.name === name);
      if (add && !existing && configured.some(e => e.name.replaceAll("-", "_") === name.replaceAll("-", "_"))) throw new McpUserError("mcp.collision");
      if (!existing && !add) throw new McpUserError("mcp.notFound");
      if (existing?.scope === "extension") throw new McpUserError("mcp.extension");
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
      if (current !== before) throw new McpUserError("mcp.concurrent");
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
    const locale = op.language ?? "en";
    const rows: string[] = [message(locale, "mcp.statusHeader", { state: message(locale, this.opts.enabled() ? "mcp.enabled" : "mcp.disabled") })];
    for (const entry of entries) {
      if (!this.opts.enabled() || entry.config.enabled === false) { rows.push(message(locale, "mcp.statusDisabled", { name: entry.name, exposure: entry.config.exposure ?? "codemode" })); continue; }
      const c = await this.connection(entry, op.cwd);
      try {
        try { await c.getClient(); } catch { /* State, never raw provider errors/credentials. */ }
        rows.push(message(locale, "mcp.statusRow", { name: entry.name, state: c.state, count: c.tools.length, exposure: entry.config.exposure ?? "codemode", scope: entry.scope ?? "configured" }));
        if (tools) rows.push(...c.tools.map(t => `  ${t.name}`));
      } finally { await c.close(); }
    }
    if (!entries.length) rows.push(message(locale, "mcp.noServers"));
    const flows = [...this.logins.values()].filter(f => f.owner === op.owner);
    rows.push(...flows.map(f => message(locale, "mcp.loginRow", { id: f.id, name: f.name, state: f.state })));
    return rows.join("\n");
  }
  private abortLogin(flow: Login): void {
    flow.controller.abort();
    void flow.connection?.close().catch(() => {});
  }
  private async beginLogin(name: string, op: McpOperator): Promise<string> {
    const locale = op.language ?? "en"; // Immutable for the lifetime of this login.
    const entry = await this.entry(name, op.cwd);
    if (!this.opts.enabled() || entry.config.enabled === false) throw new McpUserError("mcp.enableFirst");
    const active = [...this.logins.values()].find(f => f.name === name && ["starting", "waiting"].includes(f.state));
    if (active) return active.owner === op.owner ? message(locale, "mcp.activeLogin", { id: active.id, state: active.state }) : message(locale, "mcp.loginInProgress");
    // Bounded metadata retention; never evict an active authorization.
    for (const [id, flow] of this.logins) if (!["starting", "waiting"].includes(flow.state)) this.logins.delete(id);
    if (this.logins.size >= 16) throw new McpUserError("mcp.tooMany");
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
                notify(message(locale, "mcp.authUrl", { name, url: url.href, id: flow.id }));
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
        notify(message(locale, "mcp.authComplete", { name, count: c.tools.length, id: flow.id }));
      } catch {
        flow.state = flow.controller.signal.aborted ? "cancelled" : "failed";
        notify(message(locale, "mcp.authFailed", { name, state: message(locale, flow.state === "cancelled" ? "mcp.cancelled" : "mcp.failed"), id: flow.id }));
      } finally { clearTimeout(timeout); flow.finishRedirect?.(undefined); await c.close(); }
    })().catch(() => { clearTimeout(timeout); flow.state = flow.controller.signal.aborted ? "cancelled" : "failed"; notify(message(locale, "mcp.authFailedShort", { name, state: message(locale, flow.state === "cancelled" ? "mcp.cancelled" : "mcp.failed") })); });
    return message(locale, "mcp.loginStarted", { name, id: flow.id });
  }
  async execute(args: string, op: McpOperator): Promise<string> {
    try { return await this.executeInner(args, op); } catch (error) { return localizeError(error, op.language ?? "en"); }
  }
  private async executeInner(args: string, op: McpOperator): Promise<string> {
    if (this.stopping) throw new McpUserError("mcp.shuttingDown");
    const locale = op.language ?? "en";
    const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(args.trim());
    const action = match?.[1] ?? "status", name = match?.[2], rest = match?.[3];
    if (action === "help") return message(op.language ?? "en", "mcp.help");
    if (action === "status" || action === "list" || action === "tools") {
      if (rest || (action === "tools" && !name)) throw Error("Use /mcp status [name] or /mcp tools <name>");
      return this.status(name, op, action === "tools");
    }
    if (action === "auth" || action === "cancel") {
      // Resolve only this authenticated actor/conversation's flows. Exact IDs
      // remain compatible; names select a pending sign-in, never another owner.
      const own = [...this.logins.values()].filter(f => f.owner === op.owner);
      const byId = own.find(f => f.id === name);
      const named = own.filter(f => f.name === name && ["starting", "waiting"].includes(f.state));
      if (!byId && named.length > 1) throw new McpUserError("mcp.multiple");
      const flow = byId ?? named[0] ?? own.find(f => f.name === name);
      if (!name || !flow) throw new McpUserError("mcp.loginNotFound");
      if (!["starting", "waiting"].includes(flow.state)) throw new McpUserError("mcp.notPending");
      if (action === "cancel") { if (rest) throw Error("Use /mcp cancel <server-name|login-id>"); this.abortLogin(flow); return message(locale, "mcp.cancelRequested"); }
      if (!rest || rest.length > 8192 || !flow.finishRedirect) throw new McpUserError("mcp.notWaiting");
      let url: URL; try { url = new URL(rest); } catch { throw new McpUserError("mcp.invalidRedirect"); }
      if (!/^(https?:)$/.test(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new McpUserError("mcp.loopback");
      if (JSON.stringify(await this.entry(flow.name, op.cwd)) !== flow.fingerprint) { flow.controller.abort(); throw new McpUserError("mcp.changed"); }
      flow.finishRedirect(rest);
      return message(locale, "mcp.redirectReceived");
    }
    if ((action === "enable" || action === "disable") && !name) {
      if (rest) throw Error("Use /mcp enable|disable [name]");
      if (action === "disable") for (const flow of this.logins.values()) this.abortLogin(flow);
      await this.opts.setEnabled(action === "enable"); await this.opts.changed();
      return message(locale, "mcp.globalChanged", { state: message(locale, action === "enable" ? "mcp.enabled" : "mcp.disabled") });
    }
    if (!name) throw new McpUserError("mcp.help");
    if (action === "add" || action === "edit") {
      if (!rest) throw Error("Use /mcp add|edit <name> <url or JSON configuration>");
      let raw: unknown;
      try {
        if (rest.startsWith("-- ")) { const [command, ...args] = mcpArguments(rest.slice(3)); raw = { command, args }; }
        else if (rest.startsWith("--url ")) raw = { url: rest.slice(6).trim() };
        else raw = /^https?:\/\//.test(rest) ? { url: rest } : JSON.parse(rest);
      } catch { throw new McpUserError("mcp.invalidConfig"); }
      const sdk = await this.sdk(), value = sdk.validate(name, raw);
      if (typeof value === "string") throw Error("Invalid MCP server configuration (values withheld)");
      await this.mutate(name, op.cwd, old => { if (action === "add" && old !== undefined) throw new McpUserError("mcp.exists"); return value; }, action === "add");
      if (value.enabled !== false) await this.opts.setEnabled(true);
      await this.opts.changed();
      return message(locale, "mcp.saved", { name, state: message(locale, value.enabled === false ? "mcp.disabled" : "mcp.enabled") });
    }
    if (action === "remove") { if (rest) throw Error("Use /mcp remove <name>"); await this.mutate(name, op.cwd, () => undefined); return message(locale, "mcp.removed", { name }); }
    if (["enable", "disable", "connect", "reconnect", "disconnect"].includes(action)) {
      if (rest) throw Error("Unexpected MCP arguments");
      const enabled = !["disable", "disconnect"].includes(action);
      await this.mutate(name, op.cwd, old => ({ ...(old as object), enabled }));
      if (enabled) { await this.opts.setEnabled(true); await this.opts.changed(); return this.status(name, op); }
      return message(locale, "mcp.serverDisabled", { name });
    }
    if (action === "exposure") {
      if (!["direct", "codemode", "deferred", "hidden"].includes(rest ?? "")) throw Error("Use /mcp exposure <name> direct|codemode|deferred|hidden");
      await this.mutate(name, op.cwd, old => ({ ...(old as object), exposure: rest })); return message(locale, "mcp.exposureChanged", { name, exposure: rest! });
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
      return message(locale, "mcp.signedOut", { name });
    }
    throw new McpUserError("mcp.help");
  }
  async menu(op: McpOperator): Promise<string> {
    try { return await this.menuInner(op); } catch (error) { return localizeError(error, op.language ?? "en"); }
  }
  private async menuInner(op: McpOperator): Promise<string> {
    const locale = op.language ?? "en";
    const ui = op.ui;
    if (!ui) return (await this.status(undefined, op)) + "\n\n" + message(op.language ?? "en", "mcp.help");
    const entries = await this.entries(op.cwd);
    const name = await ui.select(message(locale, "mcp.menuServers"), [...entries.map(e => ({ id: e.name, label: message(locale, "mcp.menuServer", { name: e.name, state: message(locale, e.config.enabled === false ? "mcp.disabled" : "mcp.enabled") }) })), { id: "+add", label: message(locale, "mcp.addServer") }, { id: "+help", label: message(locale, "mcp.menuHelp") }]);
    if (!name) return message(locale, "mcp.menuCancelled");
    if (name === "+help") return message(op.language ?? "en", "mcp.help");
    if (name === "+add") {
      const server = await ui.prompt(message(locale, "mcp.serverName"));
      if (!server) return message(locale, "mcp.menuCancelled");
      const transport = await ui.select(message(locale, "mcp.transport"), [{ id: "http", label: message(locale, "mcp.http") }, { id: "stdio", label: message(locale, "mcp.stdio") }]);
      if (!transport) return message(locale, "mcp.menuCancelled");
      let config: Record<string, unknown>;
      if (transport === "stdio") {
        const command = await ui.prompt(message(locale, "mcp.executable")), args = await ui.prompt(message(locale, "mcp.arguments"));
        if (!command) return message(locale, "mcp.menuCancelled");
        config = { command, args: mcpArguments(args) };
      } else {
        const url = await ui.prompt(message(locale, "mcp.endpoint"));
        if (!url) return message(locale, "mcp.menuCancelled");
        config = { url };
      }
      return this.execute(`add ${server} ${JSON.stringify(config)}`, op);
    }
    const action = await ui.select(name, ["status", "tools", "connect", "disconnect", "login", "logout", "edit", "remove", "exposure"].map(id => ({ id, label: message(locale, `mcp.action.${id}` as MessageKey) })));
    if (!action) return message(locale, "mcp.menuCancelled");
    if (action === "remove" && !(await ui.confirm(message(locale, "mcp.confirmRemove", { name })))) return message(locale, "mcp.menuCancelled");
    let value = "";
    if (action === "edit") value = await ui.prompt(message(locale, "mcp.replacement"));
    if (action === "exposure") value = await ui.select(message(locale, "mcp.toolExposure"), ["direct", "codemode", "deferred", "hidden"].map(id => ({ id, label: id })));
    if (["edit", "exposure"].includes(action) && !value) return message(locale, "mcp.menuCancelled");
    return this.execute(`${action} ${name}${value ? " " + value : ""}`, op);
  }
  async close(): Promise<void> {
    this.stopping = true;
    for (const flow of this.logins.values()) this.abortLogin(flow);
    await Promise.allSettled([...this.logins.values()].map(f => f.finished));
  }
}
