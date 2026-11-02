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
    [path.basename(configurationFile(home))]: stringify({
      agent: config.agent,
      cwd,
      ...(config.model ? { model: config.model } : {}),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      loop: { drainSeconds: 60 },
    }),
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
