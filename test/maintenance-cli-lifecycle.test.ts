import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./maintenance-owner-fixture.ts", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function message(child: ChildProcess, command?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error("owner IPC timeout")); }, 5000);
    const cleanup = () => { clearTimeout(timer); child.off("message", received); child.off("exit", exited); child.off("error", failed); };
    const received = (value: unknown) => { cleanup(); resolve(value as Record<string, unknown>); };
    const exited = () => { cleanup(); reject(Error("owner exited before reply")); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    child.once("message", received); child.once("exit", exited); child.once("error", failed);
    if (command) child.send(command);
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
    child.once("exit", (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`owner stop: ${code}/${signal}`)); });
    child.send("stop");
  });
}

test("real CLI reconciles pending intent across owner restart, applies once and retains applied status", { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-cli-owner-"));
  const endpoint = path.join(home, "control", "maintenance.sock");
  const request = path.join(home, "request.json");
  let child: ChildProcess | undefined;
  const start = async () => {
    child = fork(fixture, [home], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    assert.deepEqual(await message(child), { ready: true });
  };
  const command = async (...args: string[]) => {
    const { stdout } = await exec(process.execPath, ["--import", "tsx", cli, "maintenance", endpoint, ...args], {
      timeout: 5000, env: { ...process.env, HAYATE_AGENT_HOME: path.join(home, "invalid-home") },
    });
    return JSON.parse(stdout.trim());
  };
  try {
    // Prove this CLI path does not load configuration or start a second owner.
    await writeFile(path.join(home, "invalid-home"), "not a home directory");
    await writeFile(request, JSON.stringify({ action: "compact", preserve: "PRIVATE_INTENT", resume: "PRIVATE_NEXT" }));
    await start();
    assert.deepEqual(await command("status"), { version: 0 });
    assert.deepEqual(await command("admit", "cli-1", "0", request), { version: 1, id: "cli-1", state: "accepted" });
    assert.deepEqual(await command("status"), { version: 1, id: "cli-1", execution: "pending" });
    assert.deepEqual(await message(child!, "metrics"), { compacted: 0, opened: 1 });
    await stop(child!);
    await assert.rejects(lstat(endpoint), { code: "ENOENT" });

    await start();
    assert.deepEqual(await command("status"), { version: 1, id: "cli-1", execution: "pending" });
    // Same original request reconciles idempotently instead of scheduling another operation.
    assert.deepEqual(await command("admit", "cli-1", "0", request), { version: 1, id: "cli-1", state: "accepted" });
    assert.deepEqual(await message(child!, "resume"), { resumed: true });
    let status: unknown;
    for (let i = 0; i < 12; i++) {
      status = await command("status");
      if ((status as { execution?: string }).execution === "applied") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(status, { version: 1, id: "cli-1", execution: "applied" });
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual(await message(child!, "metrics"), { compacted: 1, opened: 1 });
    await stop(child!);

    await start();
    assert.deepEqual(await command("status"), { version: 1, id: "cli-1", execution: "applied" });
    await message(child!, "resume");
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual(await message(child!, "metrics"), { compacted: 0, opened: 1 });
  } finally {
    try { if (child) await stop(child); }
    finally { await rm(home, { recursive: true, force: true }); }
  }
});
