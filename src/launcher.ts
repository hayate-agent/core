#!/usr/bin/env node
/** External owner: never wait for business idle and never overlap runtime writers. */
import { spawn } from "node:child_process";
import { realpathSync, lstatSync, readlinkSync, readFileSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { SessionLock } from "./session-lock.js";
import { NativeSoftwareUpdates, containerRuntime, softwareUpdatePolicy, type SoftwareUpdatePolicy } from "./software-updates.js";

export interface ForegroundOptions { updates?: { home: string; policy: SoftwareUpdatePolicy; external?: boolean }; delegateOwner?: boolean }
export async function foregroundOptions(args: string[]): Promise<ForegroundOptions> {
  if (args.length && args[0] !== "run") return {};
  const { loadConfig } = await import("./config.js");
  const index = args.indexOf("--home"), config = await loadConfig(index < 0 ? undefined : args[index + 1]);
  return { updates: { home: config.home, policy: softwareUpdatePolicy(config.softwareUpdates) }, delegateOwner: true };
}
export function runtimeEntrypoint(executable: string): string {
  let selected = path.resolve(executable);
  for (let i = 0; lstatSync(selected).isSymbolicLink(); i++) {
    if (i >= 16) throw Error("Launcher symlink chain is too long");
    selected = path.resolve(path.dirname(selected), readlinkSync(selected));
  }
  return path.join(path.dirname(selected), "cli.js");
}
function baseline(entrypoint: string): string {
  const physical = realpathSync(entrypoint), hash = createHash("sha256").update(readFileSync(physical));
  const metadata = path.join(path.dirname(physical), "../build-info.json");
  if (existsSync(metadata)) hash.update(readFileSync(metadata));
  return physical + ":" + hash.digest("hex");
}
const ownEntrypoint = path.join(path.dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith(".ts") ? "cli.ts" : "cli.js");

export async function runForeground(entrypoint: string, args: string[], nodeArgs: string[] = process.execArgv, options: ForegroundOptions = {}): Promise<number> {
  let stopping = false, stopCode = 143;
  let child: ReturnType<typeof spawn> | undefined, updates: NativeSoftwareUpdates | undefined, lock: SessionLock | undefined;
  let resumeSession: string | undefined, preparedNotice: string | undefined;
  const receipts = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  const send = (value: object) => { if (child?.connected) { try { child.send(value, () => {}); } catch {} } };
  const flush = () => {
    if (stopping || receipts.size || !preparedNotice || !child?.connected) return;
    send({ type: "hayate-software-event", event: "prepared", detail: preparedNotice }); preparedNotice = undefined;
  };
  const ack = (id: string) => { clearTimeout(receipts.get(id)); receipts.delete(id); flush(); };
  const clearReceipts = () => { for (const timer of receipts.values()) clearTimeout(timer); receipts.clear(); };
  const makeOwner = (policy: SoftwareUpdatePolicy) => {
    const owner = new NativeSoftwareUpdates(options.updates!.home, policy, (event, detail) => {
      if (owner !== updates) return;
      if (event === "prepared") { preparedNotice = detail; flush(); }
      else send({ type: "hayate-software-event", event, detail });
    }, undefined, options.updates!.external, baseline(entrypoint));
    return owner;
  };
  const delegate = async (selected: string) => {
    await updates?.close(); updates = undefined; await lock?.release(); lock = undefined;
    const next = await import(pathToFileURL(path.join(path.dirname(selected), "launcher.js")).href);
    if (typeof next.runForeground !== "function") throw Error("Selected lifecycle owner unavailable");
    return next.runForeground(entrypoint, args, nodeArgs, options) as Promise<number>;
  };
  if (options.updates && !(options.updates.external ?? containerRuntime())) {
    const directory = path.join(options.updates.home, "software-updates"); await mkdir(directory, { recursive: true, mode: 0o700 });
    lock = await SessionLock.acquire(path.join(directory, "owner.lock"));
  }
  try {
    if (options.updates) { updates = makeOwner(options.updates.policy); await updates.open(); }
    const selected = updates?.entrypoint(entrypoint) ?? entrypoint;
    if (options.delegateOwner && realpathSync(selected) !== realpathSync(ownEntrypoint)) return await delegate(selected);
  } catch (error) { await updates?.close(); await lock?.release(); throw error; }
  let refreshing = Promise.resolve();
  const refresh = () => {
    const next = refreshing.then(async () => {
      if (!options.updates || stopping) return;
      const { loadConfig } = await import("./config.js");
      const policy = softwareUpdatePolicy((await loadConfig(options.updates.home)).softwareUpdates);
      if (stopping) return;
      if (JSON.stringify(policy) !== JSON.stringify(updates?.policy) || updates?.baseline !== baseline(entrypoint)) {
        await updates?.close();
        if (stopping) return;
        preparedNotice = undefined; updates = makeOwner(policy); await updates.open();
        if (stopping) updates.stop();
      }
    });
    refreshing = next.catch(() => {}); return next;
  };
  const signal = (name: NodeJS.Signals) => { stopping = true; updates?.stop(); stopCode = name === "SIGINT" ? 130 : name === "SIGHUP" ? 129 : 143; child?.kill(name); };
  const interrupt = () => signal("SIGINT"), terminate = () => signal("SIGTERM"), hangup = () => signal("SIGHUP");
  const removeSignals = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
  try {
    while (!stopping) {
      const env = { ...process.env }; delete env.HAYATE_RESTART_SESSION;
      if (resumeSession) env.HAYATE_RESTART_SESSION = resumeSession;
      child = spawn(process.execPath, [...nodeArgs, updates?.entrypoint(entrypoint) ?? entrypoint, ...args], { stdio: ["inherit", "inherit", "inherit", "ipc"], env });
      child.on("message", message => {
        const value = message as { type?: string; id?: string; action?: string; session?: string };
        if (value?.type === "hayate-restart" && /^[a-f0-9-]{36}$/.test(value.session ?? "")) resumeSession = value.session;
        if (value?.type === "hayate-runtime-ready") void refresh().then(() => { if (!stopping) { updates?.start(); flush(); } }).catch(() => {});
        if (value?.type === "hayate-software-ack" && receipts.has(value.id!)) ack(value.id!);
        if (value?.type !== "hayate-software-request" || !/^[a-f0-9-]{36}$/.test(value.id ?? "") || !["status", "check", "install"].includes(value.action ?? "")) return;
        const id = value.id!; receipts.set(id, undefined);
        void refresh().then(() => updates?.request(value.action as "status" | "check" | "install") ?? { phase: "external-owner", detail: "Native update owner unavailable", updatedAt: Date.now() }).then(status => {
          send({ type: "hayate-software-status", id, status });
          const timer = setTimeout(() => ack(id), 1000); timer.unref(); receipts.set(id, timer);
        }).catch(() => { send({ type: "hayate-software-status", id, status: { phase: "failed", detail: "Inspect retained lifecycle status", updatedAt: Date.now() } }); ack(id); });
      });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child!.once("error", reject); child!.once("close", (code, signal) => resolve({ code, signal }));
      });
      child = undefined; clearReceipts();
      if (stopping) return result.code === 1 ? 1 : stopCode;
      if (result.code !== 75) return result.code ?? (result.signal === "SIGINT" ? 130 : 1);
      await refresh(); if (stopping) return stopCode;
      await updates?.afterExit(); if (stopping) return stopCode;
      preparedNotice = undefined;
      const selected = updates?.entrypoint(entrypoint) ?? entrypoint;
      if (options.delegateOwner && realpathSync(selected) !== realpathSync(ownEntrypoint)) {
        removeSignals(); return await delegate(selected);
      }
    }
    return stopCode;
  } finally { clearReceipts(); await updates?.close(); await lock?.release(); removeSignals(); }
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  foregroundOptions(process.argv.slice(2)).then(options => runForeground(runtimeEntrypoint(process.argv[1]), process.argv.slice(2), process.execArgv, options))
    .then(code => { process.exitCode = code; }).catch(() => { console.error("Hayate Agent could not start its runtime process."); process.exitCode = 1; });
}
