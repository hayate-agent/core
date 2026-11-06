// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";

/** Bounded trusted runner, not an OS sandbox. POSIX descendants that remain in
 * its process group are killed on completion/failure. Windows kills only runner.
 */
export function runExperimentProcess(command: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: options.cwd, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const kill = () => {
      if (!child.pid) return;
      try { if (grouped) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") failure ??= new Error("Experiment process cleanup failed"); }
    };
    const fail = (error: Error) => { failure ??= error; kill(); };
    const timer = setTimeout(() => fail(new Error("Experiment process timed out")), options.timeout);
    const collect = (data: Buffer, stdout: boolean) => {
      bytes += data.length;
      if (bytes > options.maxBuffer) { fail(new Error("Experiment process output limit exceeded")); return; }
      if (stdout) chunks.push(data);
    };
    child.stdout.on("data", (data: Buffer) => collect(data, true));
    child.stderr.on("data", (data: Buffer) => collect(data, false));
    // Kill ordinary descendants even when the leader exits normally. Waiting for
    // close alone would allow a descendant inheriting pipes to hold it open.
    child.once("exit", () => kill());
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || signal) reject(new Error("Experiment process failed"));
      else resolve({ stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
