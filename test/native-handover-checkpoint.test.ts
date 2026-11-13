import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PiSession } from "../src/runtime/pi.js";
import { checkpointNativeSession } from "../src/runtime/native-session-checkpoint.js";
import { ExecutionStore } from "../src/execution.js";
import { retainedSessionFile } from "../src/runtime/retained-session-file.js";

function wrap(manager: SessionManager) {
  return new PiSession({ sessionManager: manager, isStreaming: false, isCompacting: false,
    sendCustomMessage: async (message: { customType: string; content: string; display: boolean }) => { manager.appendCustomMessageEntry(message.customType, message.content, message.display); },
  } as never, {} as never, {});
}
async function home(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "durable-native-handover-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test("real SDK handover-only session survives TWO restart boundaries before first working prompt and keeps same dispatcher execution", async t => {
  const dir = await home(t), file = path.join(dir, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "same-writer", "Finish missing work; never replay original effect", "direct");
  const first = await store.claim(task.id); await store.intent(task.id, first.token!, "original-intent", "unsafe");
  const original = SessionManager.create(dir, path.join(dir, "original"));
  original.appendMessage({ role: "user", content: "Original authorized task", timestamp: Date.now() });
  original.appendCustomMessageEntry("effect-receipt", "original-effect committed once; remaining work open", false);
  await store.workerSession(task.id, first.token!, `dispatch:${task.id}:${first.token}`);
  // First restart reclaims same execution, copies original tool evidence into a NEW native SDK session.
  const one = new ExecutionStore(file); await one.load(); await one.recover(new Map([["direct", { version: 1, replaySafe: false, reconcile: true }]]));
  const second = await one.claim(task.id, { strategy: "direct", version: 1, replaySafe: false, reconcile: true }), newKey = `dispatch:${task.id}:${second.token}`, directory = path.join(dir, "replacement");
  const replacement = SessionManager.create(dir, directory);
  await wrap(replacement).seedHandover("original-effect committed once; remaining work open");
  await one.workerSession(task.id, second.token!, newKey);
  // CRASH HERE: no user/assistant message, no worker call, no graceful dispose.
  // Native SDK continueRecent must nevertheless find the published replacement.
  const discovery = await retainedSessionFile(directory, dir);
  assert.ok(discovery, "handover must be on disk BEFORE the ledger references its new session");
  assert.equal(discovery.id, replacement.getSessionId());
  const reopened = SessionManager.continueRecent(dir, directory);
  assert.equal(reopened.getSessionId(), replacement.getSessionId(), "restart must not silently create an empty worker");
  assert.match(JSON.stringify(reopened.getBranch()), /original-effect committed once/);
  assert.equal(reopened.getBranch().filter(e => e.type === "message").length, 0, "no fake user/assistant message to force SDK persistence");
  const two = new ExecutionStore(file); await two.load(); await two.recover(new Map([["direct", { version: 1, replaySafe: false, reconcile: true }]]));
  const third = await two.claim(task.id, { strategy: "direct", version: 1, replaySafe: false, reconcile: true }); assert.equal(third.id, task.id); assert.equal(third.recoverySession, newKey); assert.equal(third.intent?.key, "original-intent");
  assert.equal(two.list().length, 1);
  // Working prompt may append normally; no first-write EEXIST after native publication.
  reopened.appendMessage({ role: "user", content: "Continue remaining work only", timestamp: Date.now() });
  assert.match(await readFile(reopened.getSessionFile()!, "utf8"), /Continue remaining work only/);
});

test("three separate OS processes automatically reconstruct the same Dispatcher writer across two restarts, with no parent resolve or effect replay", { timeout: 45000 }, async t => {
  const dir = await home(t), ids: string[] = [], pids: number[] = [];
  for (const phase of ["original", "handover-crash", "finish"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/dispatcher-restart-process.ts", import.meta.url)), dir, phase], { encoding: "utf8", timeout: 12000 });
    assert.equal(child.status, 0, `${phase}: ${child.stderr}\n${child.stdout}`);
    const receipt = JSON.parse(child.stdout.trim()); ids.push(receipt.executionId); pids.push(receipt.pid);
  }
  assert.equal(new Set(ids).size, 1); assert.equal(new Set(pids).size, 3);
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  assert.equal(store.list().length, 1); assert.equal(store.list()[0]!.status, "completed");
  assert.equal(store.list()[0]!.resolutions, undefined, "automatic restart needs no parent/owner unblock");
  assert.equal(await readFile(path.join(dir, "counter"), "utf8"), "original-effect\n");
  assert.equal(await readFile(path.join(dir, "remaining"), "utf8"), "remaining-work-complete\n");
});

test("real Dispatcher restart after first intent but before first model prompt automatically continues the same prepared worker", { timeout: 30000 }, async t => {
  const dir = await home(t), receipts = [];
  for (const phase of ["admission-crash", "admission-finish"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/dispatcher-restart-process.ts", import.meta.url)), dir, phase], { encoding: "utf8", timeout: 12000 });
    assert.equal(child.status, 0, `${phase}: ${child.stderr}\n${child.stdout}`); receipts.push(JSON.parse(child.stdout.trim()));
  }
  assert.equal(receipts[0].executionId, receipts[1].executionId); assert.notEqual(receipts[0].pid, receipts[1].pid);
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  assert.equal(store.list()[0]!.status, "completed"); assert.equal(store.list()[0]!.resolutions, undefined);
  assert.equal(await readFile(path.join(dir, "counter"), "utf8"), "original-effect\n");
});

test("same-process working append after seed persistence does not enter SDK first-write EEXIST loop", async t => {
  const dir = await home(t), manager = SessionManager.create(dir, dir), session = wrap(manager);
  await session.seedHandover("already completed effect A"); const before = await readFile(manager.getSessionFile()!, "utf8");
  await session.seedHandover("already completed effect A"); assert.equal(await readFile(manager.getSessionFile()!, "utf8"), before);
  manager.appendMessage({ role: "user", content: "Do only B", timestamp: Date.now() });
  await checkpointNativeSession(manager);
  assert.match(await readFile(manager.getSessionFile()!, "utf8"), /Do only B/);
  assert.equal(manager.getBranch().filter(e => e.type === "custom_message").length, 1);
});

test("conflicting existing native file is never overwritten or adopted", async t => {
  const dir = await home(t), manager = SessionManager.create(dir, dir), file = manager.getSessionFile()!;
  await writeFile(file, "conflicting partial SDK file");
  await assert.rejects(wrap(manager).seedHandover("retained fact"), /conflicts/);
  assert.equal(await readFile(file, "utf8"), "conflicting partial SDK file");
  assert.deepEqual((await readdir(dir)).filter(f => f.endsWith(".tmp")), []);
});

test("symlink native target cannot overwrite an unrelated file", async t => {
  const dir = await home(t), manager = SessionManager.create(dir, dir), other = path.join(dir, "unrelated");
  await writeFile(other, "preserve"); await symlink(other, manager.getSessionFile()!);
  await assert.rejects(wrap(manager).seedHandover("retained fact"));
  assert.equal(await readFile(other, "utf8"), "preserve");
});

test("in-memory external provider handover waits for its provider checkpoint, without creating native file", async () => {
  const manager = SessionManager.inMemory(), session = wrap(manager); let persisted = false;
  const providerSession = new PiSession((session as unknown as { session: never }).session, {} as never, {}, async () => { persisted = true; });
  await providerSession.seedHandover("existing exact receipt");
  assert.equal(persisted, true); assert.equal(manager.getSessionFile(), undefined);
});
