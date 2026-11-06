#!/usr/bin/env node
/** Foreground process owner. Only exit 75 requests a restart; never overlap writers. */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function runForeground(entrypoint: string, args: string[], nodeArgs: string[] = process.execArgv): Promise<number> {
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  let resumeSession: string | undefined;
  const signal = (name: NodeJS.Signals) => { stopping = true; child?.kill(name); };
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
        child!.once("exit", (code, signal) => resolve({ code, signal }));
      });
      child = undefined;
      if (stopping) return result.signal === "SIGINT" ? 130 : 143;
      if (result.code !== 75) return result.code ?? (result.signal === "SIGINT" ? 130 : 1);
    }
    return 143;
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  runForeground(fileURLToPath(new URL("./cli.js", import.meta.url)), process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(() => { console.error("Hayate Agent could not start its runtime process."); process.exitCode = 1; });
}
