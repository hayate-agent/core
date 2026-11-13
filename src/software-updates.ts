import { startupQualificationProgram } from "./startup-qualification.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restoreVerifiedMatrixAddon } from "./native-addon-cache.js";
import { writeFileDurable } from "./durable.js";

export const softwareComponents = ["core", "plugins", "webui"] as const;
export type SoftwareComponent = typeof softwareComponents[number];
export interface SoftwareUpdateSource { repository: string; branch?: string }
export interface SoftwareUpdateConfig {
  enabled?: boolean;
  autoInstall?: boolean;
  checkEverySeconds?: number;
  sources?: Partial<Record<SoftwareComponent, SoftwareUpdateSource>>;
}
export interface SoftwareUpdatePolicy {
  enabled: boolean; autoInstall: boolean; checkEverySeconds: number;
  sources: Record<SoftwareComponent, Required<SoftwareUpdateSource>>;
}
export function softwareUpdatePolicy(value: SoftwareUpdateConfig = {}): SoftwareUpdatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["enabled", "autoInstall", "checkEverySeconds", "sources"].includes(k))) throw Error("Invalid softwareUpdates");
  for (const key of ["enabled", "autoInstall"] as const) if (value[key] !== undefined && typeof value[key] !== "boolean") throw Error(`softwareUpdates.${key} must be boolean`);
  const checkEverySeconds = value.checkEverySeconds ?? 3600;
  if (!Number.isSafeInteger(checkEverySeconds) || checkEverySeconds < 60 || checkEverySeconds > 604800) throw Error("softwareUpdates.checkEverySeconds must be 60..604800");
  if (value.sources !== undefined && (!value.sources || typeof value.sources !== "object" || Array.isArray(value.sources) || Object.keys(value.sources).some(k => !softwareComponents.includes(k as SoftwareComponent)))) throw Error("Invalid software update sources");
  const sources = {} as SoftwareUpdatePolicy["sources"];
  for (const component of softwareComponents) {
    const source = value.sources?.[component] ?? { repository: `https://github.com/hayate-agent/${component}.git` };
    if (!source || typeof source.repository !== "string" || Object.keys(source).some(k => !["repository", "branch"].includes(k))) throw Error(`Invalid ${component} update source`);
    let valid = false;
    try { const url = new URL(source.repository); valid = ["https:", "ssh:", "file:"].includes(url.protocol) && !url.password && (url.protocol === "ssh:" || !url.username) && !url.search && !url.hash; } catch { /* Require an explicit URL, never shell fragments or Git command options. */ }
    const branch = source.branch ?? "main";
    if (!valid || source.repository.length > 2000 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(branch) || branch.includes("..") || branch.includes("//")) throw Error(`Invalid ${component} repository/branch`);
    sources[component] = { repository: source.repository, branch };
  }
  return { enabled: value.enabled ?? true, autoInstall: value.autoInstall ?? true, checkEverySeconds, sources };
}

export function containerRuntime(): boolean {
  return process.env.HAYATE_RUNTIME_KIND === "container" || !!process.env.KUBERNETES_SERVICE_HOST || existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}
export type SoftwareUpdateAction = "status" | "check" | "install";
interface Plan { id: string; revisions: Record<SoftwareComponent, string>; sources: SoftwareUpdatePolicy["sources"] }
interface Selection { schema: 1; release: string; plan: Plan; baseline?: string; installation?: "automatic" | "operator" }
export interface SoftwareUpdateStatus {
  phase: "idle" | "checking" | "available" | "preparing" | "prepared" | "activated" | "failed" | "external-owner" | "disabled";
  detail: string; requestId?: string; plan?: Plan; selection?: Selection; pendingSelection?: Selection; updatedAt: number;
}
export type UpdateCommand = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>;

/** No shell, no prompts, finite command lifetime, no credential-bearing stderr in receipts. */
export const updateCommand: UpdateCommand = (command, args, cwd, additions, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|TZ|LANG|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|LC_[A-Z_]+|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|SSH_AUTH_SOCK|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy|GIT_[A-Z_]+|NPM_CONFIG_[A-Z_]+|npm_config_[a-z_]+|NPM_TOKEN)$/.test(name)));
  const child = spawn(command, args, { cwd, env: { ...environment, GIT_TERMINAL_PROMPT: "0", ...additions },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  const terminate = () => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* Child may already have exited. */ }
    clearTimeout(timer); child.stdout.destroy(); child.unref();
    reject(Error("update preparation interrupted; active installation unchanged"));
  };
  const timer = setTimeout(terminate, 600_000);
  signal?.addEventListener("abort", terminate, { once: true });
  child.stdout.on("data", data => { if (output.length < 16384) output += String(data).slice(0, 16384 - output.length); });
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", terminate); };
  child.once("error", () => { cleanup(); reject(Error("update command unavailable")); });
  child.once("close", code => { cleanup(); if (code === 0) resolve(output); else reject(Error("update command failed")); });
});

/** External foreground-owner service. Never awaits business idle or writes the
 * agent's ledgers, operator worktrees, config, credentials or running modules.
 * Preparation is private; selection is committed ONLY after the old child exits.
 */
export class NativeSoftwareUpdates {
  private status: SoftwareUpdateStatus = { phase: "idle", detail: "No source check yet", updatedAt: Date.now() };
  private selection?: Selection;
  private prepared?: Selection;
  private busy = false;
  private installRequested = false;
  private operatorInstall = false;
  private pending?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private requests: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly directory: string;
  private readonly abort = new AbortController();
  constructor(readonly home: string, readonly policy: SoftwareUpdatePolicy,
    private readonly notify: (event: "available" | "prepared", detail: string) => void,
    private readonly runCommand: UpdateCommand = updateCommand, private readonly external = containerRuntime(), readonly baseline?: string) {
    this.directory = path.join(home, "software-updates");
  }
  private command(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
    this.abort.signal.throwIfAborted();
    return this.runCommand(command, args, cwd, env, this.abort.signal);
  }
  async open(): Promise<void> {
    if (this.external) return; // A mounted native profile cannot replace container code.
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const selected = JSON.parse(await readFile(path.join(this.directory, "selected.json"), "utf8")) as Selection;
      await this.verifySelection(selected);
      if (selected.baseline === this.baseline) {
        await this.publishCurrent(selected);
        this.selection = selected;
        this.status = { phase: "activated", detail: "Selected native source installation", selection: selected, updatedAt: Date.now() };
      } // An externally replaced base supersedes its old self-update selector.
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Invalid native update selection; reconcile before starting"); }
    try {
      const retained = JSON.parse(await readFile(path.join(this.directory, "status.json"), "utf8")) as SoftwareUpdateStatus;
      if (retained.phase === "prepared" && retained.pendingSelection && retained.pendingSelection.plan.id !== this.selection?.plan.id && retained.pendingSelection.baseline === this.baseline &&
          this.policy.enabled && !this.external && JSON.stringify(retained.pendingSelection.plan.sources) === JSON.stringify(this.policy.sources)) {
        await this.verifySelection(retained.pendingSelection); this.prepared = retained.pendingSelection; this.status = retained;
      } else if (["checking", "preparing"].includes(retained.phase)) {
        this.status = { ...this.status, phase: "failed", detail: "Previous preparation interrupted; active selection unchanged; next check can prepare afresh", updatedAt: Date.now() };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.status = { ...this.status, phase: "failed", detail: "Preparation journal unconfirmed; active selection unchanged", updatedAt: Date.now() }; }
  }
  start(): void {
    if (this.timer || this.stopped || this.external || !this.policy.enabled) return;
    if (this.prepared) {
      if (this.prepared.installation === "operator" || this.policy.autoInstall) this.notify("prepared", "Previously validated source installation awaits durable restart");
      return;
    }
    const tick = async () => {
      this.timer = undefined;
      if (this.stopped) return;
      if (!this.busy && !this.prepared) void this.queue("check", this.policy.autoInstall).catch(() => {});
      this.timer = setTimeout(tick, this.policy.checkEverySeconds * 1000); this.timer.unref();
    };
    // Do not make startup depend on network availability. Preparation runs beside
    // the runtime and never consumes a Dispatcher/Main worker or its budget.
    this.timer = setTimeout(tick, this.policy.checkEverySeconds * 1000); this.timer.unref();
  }
  stop(): void { this.stopped = true; this.abort.abort(); clearTimeout(this.timer); this.timer = undefined; }
  async close(): Promise<void> {
    this.stop();
    await this.requests.catch(() => {});
    await this.pending?.catch(() => {});
    await this.writing.catch(() => {});
  }
  snapshot(): SoftwareUpdateStatus {
    if (this.external) return { phase: "external-owner", detail: "Container image updates belong to its deployment owner; /restart remains available", updatedAt: Date.now() };
    if (!this.policy.enabled) return { ...this.status, phase: "disabled", detail: "Native source updates disabled in agent configuration" };
    return structuredClone(this.status);
  }
  request(action: SoftwareUpdateAction): Promise<SoftwareUpdateStatus> {
    const next = this.requests.catch(() => {}).then(() => this.handleRequest(action));
    this.requests = next; return next;
  }
  private async handleRequest(action: SoftwareUpdateAction): Promise<SoftwareUpdateStatus> {
    if (!["status", "check", "install"].includes(action)) throw Error("Invalid update action");
    if (action === "status" || this.external || !this.policy.enabled) return this.snapshot();
    if (this.prepared) {
      if (action === "install" && this.prepared.installation !== "operator") {
        this.prepared = { ...this.prepared, installation: "operator" };
        await writeFileDurable(path.join(this.directory, "releases", this.prepared.release, "prepared.json"), JSON.stringify(this.prepared) + "\n");
        await this.save({ pendingSelection: this.prepared });
        this.notify("prepared", "Validated source installation explicitly approved for durable restart");
      }
      return this.snapshot();
    }
    if (this.busy && this.status.phase === "failed") await this.pending;
    if (this.busy) {
      if (action === "install") {
        await this.save({ detail: "Explicit installation approved; source preparation pending" });
        this.installRequested = true; this.operatorInstall = true;
        void this.pending?.then(() => {
          if (!this.busy && !this.prepared && !this.stopped) return this.queue("install", true);
        }).catch(() => {});
      }
      return this.snapshot();
    }
    return this.queue(action, action === "install");
  }
  private async queue(_action: "check" | "install", install: boolean): Promise<SoftwareUpdateStatus> {
    this.busy = true;
    this.installRequested = install;
    this.operatorInstall = _action === "install";
    this.status = { ...this.status, phase: "checking", detail: "Checking configured Core, Plugins and WebUI sources", requestId: randomUUID(), updatedAt: Date.now() };
    // Durable acknowledgement before any network/build work. The command turn
    // never waits for installation and cannot become its own admission blocker.
    try { await this.save({}); } catch (error) { this.busy = false; throw error; }
    if (this.stopped) { this.busy = false; return this.snapshot(); }
    this.pending = this.run(install).finally(() => { this.busy = false; });
    void this.pending.catch(() => {});
    return this.snapshot();
  }
  private async save(patch: Partial<SoftwareUpdateStatus>): Promise<void> {
    if (this.stopped) return;
    const write = this.writing.catch(() => {}).then(async () => {
      if (this.stopped) return;
      const next = { ...this.status, ...patch, updatedAt: Date.now() };
      await writeFileDurable(path.join(this.directory, "status.json"), JSON.stringify(next) + "\n");
      if (!this.stopped) this.status = next;
    });
    this.writing = write; await write;
  }
  private async run(install: boolean): Promise<void> {
    let component: SoftwareComponent = "core", stage = "source lookup";
    try {
      await this.save({});
      const revisions = {} as Plan["revisions"];
      for (component of softwareComponents) {
        const source = this.policy.sources[component];
        const result = await this.command("git", ["ls-remote", "--exit-code", source.repository, `refs/heads/${source.branch}`], this.directory);
        const lines = result.trim().split("\n");
        if (lines.length !== 1 || !/^[a-f0-9]{40}\s/.test(lines[0]!)) throw Error("invalid source identity");
        revisions[component] = lines[0]!.split(/\s/)[0]!;
      }
      const id = createHash("sha256").update(JSON.stringify({ revisions, sources: this.policy.sources })).digest("hex");
      const plan: Plan = { id, revisions, sources: this.policy.sources };
      if (id === this.selection?.plan.id) { await this.save({ phase: "activated", detail: "All three configured sources are current", plan }); return; }
      await this.save({ phase: "available", detail: "New source versions available; /update install downloads, validates and restarts", plan });
      this.notify("available", softwareComponents.map(c => `${c} ${revisions[c].slice(0, 12)}`).join(", "));
      if ((!install && !this.installRequested) || this.stopped) return;
      const release = randomUUID(); const root = path.join(this.directory, "releases", release);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await this.save({ phase: "preparing", detail: "Preparing isolated source installation; current work continues" });
      stage = "source download";
      for (component of softwareComponents) {
        const destination = path.join(root, component); await mkdir(destination);
        await this.command("git", ["init", "--quiet"], destination);
        await this.command("git", ["remote", "add", "origin", plan.sources[component].repository], destination);
        await this.command("git", ["fetch", "--depth=64", "origin", plan.revisions[component]], destination);
        await this.command("git", ["checkout", "--detach", "FETCH_HEAD"], destination);
        if ((await this.command("git", ["rev-parse", "HEAD"], destination)).trim() !== plan.revisions[component]) throw Error("source checkout mismatch");
      }
      // Core's hash lock remains authoritative for bundled plugins, even if a
      // newer independent Plugins HEAD exists. Never silently rewrite that lock.
      component = "plugins"; stage = "locked plugin preparation";
      let bundledPlugins = existsSync(path.join(root, "core/vendor/plugins")) ? path.join(root, "core/vendor/plugins") : path.join(root, "plugins");
      const lockFile = path.join(root, "core", "plugins.lock.json");
      try {
        const lock = JSON.parse(await readFile(lockFile, "utf8"));
        if (!/^[a-f0-9]{40}$/.test(lock.revision)) throw Error("invalid plugin lock");
        if (lock.revision !== revisions.plugins && bundledPlugins === path.join(root, "plugins")) {
          await this.command("git", ["fetch", "--depth=1", "origin", lock.revision], bundledPlugins);
          const locked = path.join(root, "bundled-plugins");
          await this.command("git", ["worktree", "add", "--detach", locked, lock.revision], bundledPlugins);
          bundledPlugins = locked;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const buildEnv = { HAYATE_PLUGIN_SOURCE: bundledPlugins,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` };
      for (component of ["core", "webui"] as const) {
        stage = "dependency installation";
        const cwd = path.join(root, component);
        await this.command("npm", ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd, buildEnv);
        const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
        if (pkg.dependencies?.["@matrix-org/matrix-sdk-crypto-nodejs"]) {
          // npm12 may report successful rebuild while silently blocking this
          // install script. Run only this reviewed native downloader explicitly,
          // then require the addon so a missing binary fails before tests/stop.
          stage = "native dependency verification";
          const cacheSources = [fileURLToPath(new URL("../", import.meta.url)),
            ...(this.selection ? [path.join(this.directory, "releases", this.selection.release, "core")] : [])];
          if (!await restoreVerifiedMatrixAddon(cwd, cacheSources))
            await this.command(process.execPath, [path.join(cwd, "node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js")], cwd, buildEnv);
          await this.command(process.execPath, ["--input-type=commonjs", "-e", "require('@matrix-org/matrix-sdk-crypto-nodejs')"], cwd, buildEnv);
        }
        stage = "build"; await this.command("npm", ["run", "build"], cwd, buildEnv);
        // Development test suites belong to release CI, never to agent startup
        // or update admission. Only qualify the installed runtime entrypoints.
        stage = "runtime entrypoint check";
        if (component === "core") {
          await this.command(process.execPath, ["--check", path.join(cwd, "dist/cli.js")], cwd, buildEnv);
          stage = "startup configuration compatibility";
          await this.command(process.execPath, ["--input-type=module", "--eval", startupQualificationProgram(cwd, this.home)], cwd, buildEnv);
        }
      }
      component = "core"; stage = "source identity metadata";
      const corePackage = JSON.parse(await readFile(path.join(root, "core/package.json"), "utf8"));
      // Match only tags on the installed commit or its checked-out ancestors.
      // A newer uninstalled release must never become this runtime's version.
      const { sourceVersion } = await import("./source-version.js");
      let tags = "", history = "";
      try {
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]);
        tags = await this.runCommand("git", ["ls-remote", "--tags", "origin"], path.join(root, "core"), undefined, signal);
        history = await this.runCommand("git", ["rev-list", "--first-parent", "--max-count=64", revisions.core], path.join(root, "core"), undefined, signal);
      } catch { /* Version lookup is informational, never an installation gate. */ }
      const version = sourceVersion(revisions.core, tags, history, corePackage.version);
      await writeFileDurable(path.join(root, "core/build-info.json"), JSON.stringify({ version, revision: revisions.core }) + "\n");
      const selection: Selection = { schema: 1, release, plan, installation: this.operatorInstall ? "operator" : "automatic", ...(this.baseline ? { baseline: this.baseline } : {}) };
      await writeFileDurable(path.join(root, "prepared.json"), JSON.stringify(selection) + "\n");
      await this.verifySelection(selection);
      if (this.stopped) { await this.save({ phase: "available", detail: "Prepared source retained; process owner is stopping" }); return; }
      this.prepared = selection;
      await this.save({ phase: "prepared", pendingSelection: selection, detail: "Validated installation prepared; requesting bounded durable restart" });
      this.notify("prepared", `Core, Plugins, WebUI prepared (${id.slice(0, 12)})`);
    } catch {
      await this.save({ phase: "failed", detail: `${component}: ${stage} failed; previous installation untouched; next scheduled check retries preparation` }).catch(() => {});
    }
  }
  private async verifySelection(selection: Selection): Promise<void> {
    if (selection?.schema !== 1 || !/^[0-9a-f-]{36}$/.test(selection.release) || !/^[0-9a-f]{64}$/.test(selection.plan?.id ?? "")) throw Error("Invalid source selection");
    if (softwareComponents.some(c => !/^[a-f0-9]{40}$/.test(selection.plan.revisions?.[c] ?? "")) ||
        createHash("sha256").update(JSON.stringify({ revisions: selection.plan.revisions, sources: selection.plan.sources })).digest("hex") !== selection.plan.id) throw Error("Source plan identity mismatch");
    softwareUpdatePolicy({ sources: selection.plan.sources });
    const root = path.join(this.directory, "releases", selection.release);
    const canonical = path.join(await realpath(this.directory), "releases", selection.release);
    if ((await realpath(root)) !== canonical || (await realpath(path.join(root, "core/dist/cli.js"))) !== path.join(canonical, "core/dist/cli.js")) throw Error("Source selection escapes installation");
    if (!(await stat(path.join(root, "core/dist/launcher.js"))).isFile()) throw Error("Missing native lifecycle owner");
    const prepared = JSON.parse(await readFile(path.join(root, "prepared.json"), "utf8"));
    if (JSON.stringify(prepared) !== JSON.stringify(selection) || !(await stat(path.join(root, "core/dist/cli.js"))).isFile()) throw Error("Unprepared source selection");
  }
  private async publishCurrent(selection: Selection): Promise<void> {
    const temporary = path.join(this.directory, `.current-${randomUUID()}`);
    try {
      await symlink(path.join("releases", selection.release), temporary, process.platform === "win32" ? "junction" : "dir");
      await rename(temporary, path.join(this.directory, "current"));
      // The following durable status publication fsyncs this same directory;
      // selected.json remains authoritative and boot repairs an interrupted link.
    } finally { await unlink(temporary).catch(() => {}); }
  }
  /** Called by the foreground process owner after close, never by a worker/tool.
   * No old runtime can write beside the selected replacement at this boundary. */
  async afterExit(): Promise<void> {
    if (!this.prepared || !this.policy.enabled || this.external || this.stopped ||
        (this.prepared.installation !== "operator" && !this.policy.autoInstall)) return;
    await this.verifySelection(this.prepared);
    if (this.stopped) return;
    await writeFileDurable(path.join(this.directory, "selected.json"), JSON.stringify(this.prepared) + "\n", 0o600, () => {
      if (this.stopped) throw Error("Owner is stopping");
    });
    if (this.stopped) return;
    await this.publishCurrent(this.prepared);
    this.selection = this.prepared; this.prepared = undefined;
    await this.save({ phase: "activated", detail: "Old runtime exited; replacement installation selected", selection: this.selection, pendingSelection: undefined });
  }
  entrypoint(original: string): string {
    return this.selection ? path.join(this.directory, "releases", this.selection.release, "core/dist/cli.js") : original;
  }
}
