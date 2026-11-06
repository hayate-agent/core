#!/usr/bin/env node
/** Foreground process owner. Only exit 75 requests a restart; never overlap writers. */
import { spawn } from "node:child_process";
import { realpathSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Follow executable shims, but preserve directory selectors such as current/.
 * The next child must load the selected release, not this launcher's old imports. */
export function runtimeEntrypoint(executable: string): string {
  let selected = path.resolve(executable);
  for (let i = 0; lstatSync(selected).isSymbolicLink(); i++) {
    if (i >= 16) throw Error("Launcher symlink chain is too long");
    selected = path.resolve(path.dirname(selected), readlinkSync(selected));
  }
  return path.join(path.dirname(selected), "cli.js");
}

export async function runForeground(entrypoint: string, args: string[], nodeArgs: string[] = process.execArgv): Promise<number> {
  let stopping = false;
  let stopCode = 143;
  let child: ReturnType<typeof spawn> | undefined;
  let resumeSession: string | undefined;
  const signal = (name: NodeJS.Signals) => { stopping = true; stopCode = name === "SIGINT" ? 130 : 143; child?.kill(name); };
  const interrupt = () => signal("SIGINT");
  const terminate = () => signal("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    while (!stopping) {
      const env = { ...process.env };
      delete env.HAYATE_RESTART_SESSION;
      if (resumeSession) env.HAYATE_RESTART_SESSION = resumeSession;
      child = spawn(process.execPath, [...nodeArgs, entrypoint, ...args], { stdio: ["inherit", "inherit", "inherit", "ipc"], env });
      child.on("message", message => {
        const value = message as { type?: unknown; session?: unknown };
        if (value?.type === "hayate-restart" && typeof value.session === "string" && /^[0-9a-f-]{36}$/.test(value.session)) resumeSession = value.session;
      });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child!.once("error", reject);
        // close follows exit AND IPC closure, so the final session handoff has
        // been consumed before the replacement inherits its restart metadata.
        child!.once("close", (code, signal) => resolve({ code, signal }));
      });
      child = undefined;
      if (stopping) return stopCode;
      if (result.code !== 75) return result.code ?? (result.signal === "SIGINT" ? 130 : 1);
    }
    return stopCode;
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  runForeground(runtimeEntrypoint(process.argv[1]), process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(() => { console.error("Hayate Agent could not start its runtime process."); process.exitCode = 1; });
}
