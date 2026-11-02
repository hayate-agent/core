import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionLock } from "../src/session-lock.js";
import { LocalSessions } from "../src/local-sessions.js";

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-lock-"));
  return { home, lock: path.join(home, "home.lock") };
}
async function child(lock: string, mode = "lock"): Promise<{ process: ChildProcess; result: string }> {
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", "test/fixtures/session-lock-child.ts", lock, mode], {
    cwd: globalThis.process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  process.stderr!.on("data", (chunk) => { stderr += chunk; });
  const result = await Promise.race([
    once(process, "message").then(([message]) => String(message)),
    once(process, "exit").then(([code]) => { throw Error(`child exited ${code}: ${stderr}`); }),
  ]);
  return { process, result };
}
async function stop(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, "exit"); process.kill("SIGKILL"); await exited;
}

test("SIGKILL releases kernel ownership; persistent locks recover without PID/incarnation guesses", { timeout: 20000 }, async () => {
  const { home, lock } = await fixture();
  let owner: ChildProcess | undefined;
  try {
    const first = await child(lock); owner = first.process;
    assert.equal(first.result, "acquired");
    await assert.rejects(SessionLock.acquire(lock), /already open/);
    await stop(owner);
    const next = await SessionLock.acquire(lock);
    await next.release();
    const restarted = await child(lock); owner = restarted.process;
    assert.equal(restarted.result, "acquired");
  } finally { if (owner) await stop(owner); await rm(home, { recursive: true, force: true }); }
});

test("concurrent crash-recovery contenders grant exactly one writer", { timeout: 20000 }, async () => {
  const { home, lock } = await fixture();
  const children: ChildProcess[] = [];
  try {
    const stale = await child(lock); children.push(stale.process); await stop(stale.process);
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      const result = await child(lock); children.push(result.process); return result.result;
    }));
    assert.equal(results.filter((result) => result === "acquired").length, 1);
    assert.equal(results.filter((result) => result === "busy").length, 7);
  } finally { await Promise.all(children.map(stop)); await rm(home, { recursive: true, force: true }); }
});

test("first-acquisition contenders also grant exactly one writer", { timeout: 20000 }, async () => {
  const { home, lock } = await fixture(); const children: ChildProcess[] = [];
  try {
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      const result = await child(lock); children.push(result.process); return result.result;
    }));
    assert.equal(results.filter((result) => result === "acquired").length, 1);
    assert.equal(results.filter((result) => result === "busy").length, 7);
  } finally { await Promise.all(children.map(stop)); await rm(home, { recursive: true, force: true }); }
});

test("LocalSessions home and session both recover after SIGKILL without changing persisted data", { timeout: 20000 }, async () => {
  const { home } = await fixture(); let owner: ChildProcess | undefined;
  const store = await LocalSessions.open(home, home);
  try {
    const result = await child(home, "home"); owner = result.process;
    assert.equal(result.result, "acquired");
    await assert.rejects(store.acquireHome(), /already open/);
    const [row] = await store.list(); assert.ok(row);
    await assert.rejects(store.resume(row.id), /already open/);
    await writeFile(path.join(home, "state.json"), "ledger sentinel");
    await writeFile(path.join(home, "e2ee-sentinel"), "encryption sentinel");
    const metadataPath = path.join(home, "local-sessions", `${row.key}.json`);
    const metadata = await readFile(metadataPath, "utf8");
    await stop(owner);
    await store.acquireHome(); await store.resume(row.id);
    assert.equal(await readFile(metadataPath, "utf8"), metadata);
    assert.equal(await readFile(path.join(home, "state.json"), "utf8"), "ledger sentinel");
    assert.equal(await readFile(path.join(home, "e2ee-sentinel"), "utf8"), "encryption sentinel");
  } finally { if (owner) await stop(owner); await store.release(); await rm(home, { recursive: true, force: true }); }
});

test("interrupted acquisition leaves inert temp files; marker-only and empty database states recover", async () => {
  const { home, lock } = await fixture();
  try {
    await writeFile(`${lock}.interrupted.tmp`, "partial");
    const first = await SessionLock.acquire(lock); await first.release();
    await writeFile(`${lock}.sqlite`, "");
    const next = await SessionLock.acquire(lock); await next.release();
    assert.equal(await readFile(`${lock}.interrupted.tmp`, "utf8"), "partial");
    assert.deepEqual((await readdir(home)).sort(), ["home.lock", "home.lock.interrupted.tmp", "home.lock.sqlite"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("release is idempotent and never unlinks successor identity", async () => {
  const { home, lock } = await fixture();
  try {
    const first = await SessionLock.acquire(lock); await first.release();
    const second = await SessionLock.acquire(lock);
    const marker = await readFile(lock, "utf8");
    await first.release();
    assert.equal(await readFile(lock, "utf8"), marker);
    await assert.rejects(SessionLock.acquire(lock), /already open/);
    await second.release();
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const contents of [String(process.pid), "2147483647", "", "{", '{"pid":1,"host":"foreign","boot":"old"}']) {
  test(`legacy/ambiguous lock fails closed without alteration: ${JSON.stringify(contents)}`, async () => {
    const { home, lock } = await fixture();
    try {
      await writeFile(lock, contents);
      await assert.rejects(SessionLock.acquire(lock), /inspect.*manually/);
      assert.equal(await readFile(lock, "utf8"), contents);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("ownership ignores reused PIDs and foreign container identities, not live kernel locks", async () => {
  const { home, lock } = await fixture();
  try {
    const original = process.kill;
    process.kill = (() => { throw Error("PID probes cannot establish ownership"); }) as typeof process.kill;
    try {
      const owner = await SessionLock.acquire(lock);
      await assert.rejects(SessionLock.acquire(lock), /already open/);
      await owner.release();
      const successor = await SessionLock.acquire(lock); await successor.release();
    } finally { process.kill = original; }
  } finally { await rm(home, { recursive: true, force: true }); }
});
