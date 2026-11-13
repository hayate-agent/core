import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile, utimes, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/runtime/pi.js";
import { FilesystemSessionProvider } from "../src/sessions.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "mem:room1", original = "Verify the update, then continue the authorized delivery";
test("startup assessment reads retained evidence before the first model session is opened, and resumes without user input", async t => {
  let turns = 0, reads = 0;
  const runtime = Object.assign(new FakeRuntime(() => { turns++; return "Verified delivery continued"; }), {
    retainedSessionHistory: async () => { reads++; return { sessionId: "retained-id", entries: [
      { id: "operator-id", role: "user", text: original },
      { id: "saved-evidence", role: "assistant", text: "ACTIVATION_CONFIRMED: verified installed source; remaining delivery authorized" },
    ] }; },
  });
  const h = new Harness({ runtime, currentRuntime: { version: "0.1.268", revision: "a".repeat(40), startedAt: 2000 },
    completionCheck: async input => {
      assert.equal(input.completionContext?.retained?.runtime?.phase, "process-started");
      assert.equal(input.completionContext?.retained?.runtime?.revision, "a".repeat(40));
      return input.continuationDepth ? { state: "completed" }
        : JSON.stringify(input.completionContext).includes("ACTIVATION_CONFIRMED") ? { state: "continue", next: "Continue retained delivery after verified update" } : undefined;
    } });
  t.after(() => h.stop(0)); h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions([{ key, replyTo: { channel: "mem", target: "room1" }, task: { id: "operator-id", original, state: "active", depth: 0, recoveryEnrollment: "current", anchor: { id: "operator-id", task: original, receivedAt: 1 }, lastReply: "Install scheduled; verify after restart" } }]);
  await h.recoverTasks(); assert.equal(reads, 1); assert.equal(runtime.sessions.size, 0, "evidence collection never opens model/tool/session writers");
  assert.equal(h.pendingInputs().length, 1); h.releaseRestored(); await h.drained();
  assert.equal(turns, 1); assert.equal(h.state(key).task!.id, "operator-id"); assert.equal(h.state(key).task!.state, "completed");
});

test("newly readable retained evidence permits one boot reassessment without resetting attempts or defeating backoff on every restart", async t => {
  let checks = 0;
  const runtime = Object.assign(new FakeRuntime(), { retainedSessionHistory: async () => ({ sessionId: "same-session", entries: [{ id: "same-head", role: "assistant", text: "retained evidence" }] }) });
  const h = new Harness({ runtime, now: () => 2000, completionCheck: async (_input, _reply, _signal, diagnostic) => { checks++; diagnostic?.("inconclusive"); return; } });
  t.after(() => h.stop(0)); h.onStateChange = async () => {};
  h.restoreSessions([{ key, task: { id: "operator", original, state: "active", depth: 3, recoveryEnrollment: "current", expiresAt: 500000,
    anchor: { id: "operator", task: original, receivedAt: 1 }, recoveryRetry: { attempts: 4, nextAt: 10000, diagnostic: "inconclusive" } } }]);
  await h.recoverTasks(); assert.equal(checks, 1); assert.equal(h.state(key).task!.recoveryRetry!.attempts, 5);
  assert.equal(h.state(key).task!.depth, 3); assert.equal(h.state(key).task!.expiresAt, 500000); assert.equal(h.pendingInputs().length, 0);
  await h.recoverTasks(); assert.equal(checks, 1);
  const restored = new Harness({ runtime, now: () => 2000, completionCheck: async () => { throw Error("unchanged history must not bypass backoff again"); } });
  t.after(() => restored.stop(0)); restored.onStateChange = async () => {}; restored.restoreSessions(h.snapshotSessions());
  await restored.recoverTasks(); assert.equal(restored.state(key).task!.recoveryRetry!.attempts, 5);
});

test("PI retained evidence honors exact provider binding and leaves files unchanged without creating a model runtime", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "retained-history-")); t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions"); const provider = new FilesystemSessionProvider(path.join(home, "provider"));
  const manager = SessionManager.inMemory(home); manager.appendMessage({ role: "user", content: "exact active scope", timestamp: 1 });
  const active = await provider.create(key, "pi-session-v1", [manager.getHeader(), ...manager.getEntries()]); await provider.bind(key, active.id);
  const other = SessionManager.inMemory(home); other.appendMessage({ role: "user", content: "UNRELATED_NEWER_HISTORY", timestamp: 2 }); await provider.create(key, "pi-session-v1", [other.getHeader(), ...other.getEntries()]);
  const before = await readFile(path.join(home, "provider", active.id + ".json"), "utf8");
  const runtime = new PiRuntime({ cwd: home, sessionsDir: dir, sessionProvider: () => provider } as ConstructorParameters<typeof PiRuntime>[0]);
  const result = await runtime.retainedSessionHistory(key);
  assert.equal(result!.sessionId, active.id); assert.match(JSON.stringify(result), /exact active scope/); assert.doesNotMatch(JSON.stringify(result), /UNRELATED_NEWER_HISTORY/);
  assert.equal(await readFile(path.join(home, "provider", active.id + ".json"), "utf8"), before);
  await assert.rejects(readdir(dir), { code: "ENOENT" }); assert.equal((runtime as unknown as { modelsRuntime?: unknown }).modelsRuntime, undefined);
});

test("legacy read matches resume cwd/mtime and never repairs missing newline or migrates the disk file", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "retained-legacy-")); t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "mem_room1"); await mkdir(dir, { recursive: true });
  const manager = SessionManager.inMemory(home); manager.appendMessage({ role: "user", content: "LEGACY_SCOPED_HISTORY", timestamp: 1 });
  const entries = [{ ...manager.getHeader()!, version: 2, metadata: "é".repeat(5000) }, ...manager.getEntries()];
  const file = path.join(dir, "current.jsonl"), foreign = path.join(dir, "foreign.jsonl");
  const raw = entries.map(entry => JSON.stringify(entry)).join("\n"); await writeFile(file, raw);
  await writeFile(foreign, [{ ...manager.getHeader()!, id: "foreign", cwd: path.join(home, "other") }, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n"));
  await utimes(file, new Date(1000), new Date(1000)); await utimes(foreign, new Date(2000), new Date(2000)); const modified = (await stat(file)).mtimeMs;
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions") } as ConstructorParameters<typeof PiRuntime>[0]);
  const result = await runtime.retainedSessionHistory(key);
  assert.equal(result!.sessionId, manager.getSessionId()); assert.match(JSON.stringify(result), /LEGACY_SCOPED_HISTORY/);
  assert.equal(await readFile(file, "utf8"), raw); assert.equal((await stat(file)).mtimeMs, modified);
  await writeFile(file, raw + "\n{broken-json"); const partial = await runtime.retainedSessionHistory(key);
  assert.equal(partial!.incomplete, true); assert.equal(await readFile(file, "utf8"), raw + "\n{broken-json");
});

test("oversized newest native header cannot silently substitute an older session", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "retained-header-budget-")); t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, "sessions", "mem_room1"); await mkdir(directory, { recursive: true });
  const manager = SessionManager.inMemory(home); manager.appendMessage({ role: "user", content: "OLDER_SESSION_MUST_NOT_GRANT", timestamp: 1 });
  await writeFile(path.join(directory, "old.jsonl"), [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n"));
  await writeFile(path.join(directory, "new.jsonl"), JSON.stringify({ ...manager.getHeader(), id: "new-id", metadata: "x".repeat(70000) }) + "\n");
  await utimes(path.join(directory, "old.jsonl"), new Date(1000), new Date(1000)); await utimes(path.join(directory, "new.jsonl"), new Date(2000), new Date(2000));
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions") } as ConstructorParameters<typeof PiRuntime>[0]);
  await assert.rejects(() => runtime.retainedSessionHistory(key), /refusing an older substitute/);
});

test("PI empty/missing retained history does not create or bind a new conversation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "retained-missing-")); t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions");
  const runtime = new PiRuntime({ cwd: home, sessionsDir: dir } as ConstructorParameters<typeof PiRuntime>[0]);
  assert.equal(await runtime.retainedSessionHistory(key), undefined); await assert.rejects(readdir(dir), { code: "ENOENT" });
});
