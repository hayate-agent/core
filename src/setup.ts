import { mkdir, open, access, stat } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { defaultConfig, loadConfig } from "./config.js";
import { configurationFile } from "./product-paths.js";

export interface InitOptions {
  home?: string;
  agent?: string;
  cwd?: string;
  model?: string;
}

/** User-owned setup only. Never replace an existing config or copy credentials. */
export async function initialize(opts: InitOptions): Promise<string[]> {
  const config = defaultConfig(opts);
  const home = path.resolve(config.home);
  const cwd = path.resolve(config.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  const files = {
    [path.basename(configurationFile(home))]: `# Hayate starter profile. No credentials or model context sizes belong here.
# Full gateway walkthrough: https://github.com/hayate-agent/core/blob/main/docs/gateways.md
# Model: select a registered model via /login and /model; no model is prescribed.
# tools is an explicit allowlist, not an OS sandbox; tools: [] exposes no tools.
` + stringify({
      agent: config.agent,
      cwd,
      ...(config.model ? { model: config.model } : {}),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      loop: config.loop,
      gateways: config.gateways,
      dispatcher: config.dispatcher,
    }) + `
# gateways above controls feedback only; it does not enable a transport.
# Matrix: inject MATRIX_HOMESERVER plus bot credentials and explicit allowed users.
# WebUI: install/build the separate trusted WebUI plugin, then put this mapping
# in settings.local.yaml (NOT this file), relative to this home:
# gatewayPlugins:
#   webui:
#     module: plugins/webui/index.mjs
# Browser: http://127.0.0.1:3210 (local only; no network authentication yet).
# Optional agent UI customization, after plugin installation:
# plugins:
#   - plugins/webui/index.mjs
# Also add plugin_webui_settings to the tools list above, then restart.
# Remote operator identities must be explicit; merge your real Matrix MXIDs
# and/or webui:local into admins/approvers only when intended:
# admins: ["@operator:example.org"]
# approvers: ["@operator:example.org"]
# Dispatcher: verify backend concurrency support before setting BOTH enabled
# and concurrentRequests to true above; capacity: 1 is a starting worker limit.
# direct uses normal isolated worker turns; sequential also needs modelRoles.
# See docs/dispatcher.md and docs/model-roles.md. Restart after startup changes.
`,
    "SOUL.md": `# Identity\n\nYou are ${config.agent}, a general-purpose personal and development assistant running in Hayate Agent.\nYour operator defines your projects and priorities. Check existing state before\nrepeating side effects after an interruption. Do not disclose credentials.\n`,
    "VOICE.md": "# Voice\n\nBe direct, precise and practical. Match the operator's language.\n",
  };
  for (const [name, text] of Object.entries(files)) {
    const dest = path.join(home, name);
    let file;
    try {
      file = await open(dest, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      await file.writeFile(text);
      created.push(dest);
    } finally {
      await file.close();
    }
  }
  return created;
}

/** Local diagnostics only: no provider request, secret values or background mutation. */
export async function diagnose(home?: string): Promise<{ ok: boolean; lines: string[] }> {
  const config = await loadConfig(home);
  const lines = ["Hayate Agent diagnostics", `Node: ${process.version}`, `Home: ${path.resolve(config.home)}`, `Workspace: ${config.cwd}`, `Agent: ${config.agent}`];
  let ok = true;
  for (const [label, dest] of [["Workspace", config.cwd], ["Configuration", configurationFile(config.home)]] as const) {
    try {
      const info = await stat(dest);
      if (label === "Workspace" ? !info.isDirectory() : !info.isFile()) throw new Error("wrong type");
      await access(dest);
      lines.push(`${label}: present`);
    } catch { ok = false; lines.push(`${label}: missing or invalid`); }
  }
  lines.push(`Model: ${config.model ?? "runtime default (configure a provider before prompting)"}`);
  lines.push(`Tools: ${config.tools?.join(", ") ?? "runtime defaults"}`);
  lines.push("Provider credentials are not checked; no model request was sent.");
  return { ok, lines };
}
