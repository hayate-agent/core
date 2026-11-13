/** Fault-injection child: actual ledger, Harness bridge and native SDK files.
 * Only the inference response is deterministic; no SDK persistence is mocked. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ExecutionStore } from "../../src/execution.js";
import { DispatcherRuntime } from "../../src/dispatcher-runtime.js";
import { Harness } from "../../src/harness.js";
import { PiSession, PiRuntime } from "../../src/runtime/pi.js";
import { Dispatcher } from "../../src/dispatcher.js";
import { retainedSessionFile } from "../../src/runtime/retained-session-file.js";

const [home, phase] = process.argv.slice(2), file = path.join(home!, "executions.json");
const store = new ExecutionStore(file); await store.load();
const managers = new Map<string, SessionManager>();
const get = (key: string) => {
  let manager = managers.get(key);
  if (!manager) { manager = SessionManager.continueRecent(home!, path.join(home!, "sessions", key.replace(/[^a-zA-Z0-9_-]/g, "_"))); managers.set(key, manager); }
  return manager;
};
const wrap = (manager: SessionManager) => new PiSession({ sessionManager: manager, isStreaming: false, isCompacting: false,
  sendCustomMessage: async (m: { customType: string; content: string; display: boolean }) => { manager.appendCustomMessageEntry(m.customType, m.content, m.display); },
} as never, {} as never, {});
const nativePreparation = new PiRuntime({ cwd: home!, sessionsDir: path.join(home!, "sessions") } as never);
const runtime = {
 prepareWorkerEvidence: (key: string, evidence: { executionId: string; task: string }) => nativePreparation.prepareWorkerEvidence(key, evidence),
 retainedSessionHistory: async (key: string) => {
  const directory = path.join(home!, "sessions", key.replace(/[^a-zA-Z0-9_-]/g, "_")), found = await retainedSessionFile(directory, home!);
  if (!found) return undefined;
  const entries = (await readFile(found.file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const manager = SessionManager.inMemory(home, undefined, entries);
  return { sessionId: found.id, sessionFile: found.file, entries: wrap(manager).archiveEntries() };
 },
 open: async (key: string) => {
  if (phase !== "original" && key === store.list()[0]!.recoverySession) throw Error("Old worker model must not reopen just to read evidence");
  const manager = get(key), pi = wrap(manager);
  return { status: () => ({ sessionId: manager.getSessionId(), model: "fixture/deterministic", thinking: "off" }),
    archiveEntries: () => pi.archiveEntries(), seedHandover: (text: string) => pi.seedHandover(text), abort: async () => {}, dispose: async () => {},
    prompt: async () => { throw Error("Fixture inference is routed explicitly, never network"); } };
} };
const harness = new Harness({ runtime: runtime as never, executionStore: store, tickMs: 60000 });
const bridge = new DispatcherRuntime(harness, store);
const recovery = { strategy: "direct", version: 1, replaySafe: false, reconcile: true };
if (phase === "admission-crash") {
  harness.accept = async input => {
    const task = store.list()[0]!;
    console.log(JSON.stringify({ pid: process.pid, phase, executionId: task.id, status: task.status }));
    process.exit(0); // Exact fault: intent/reference committed, model never opened.
  };
  const dispatcher = new Dispatcher(store, bridge.strategy, 1, async () => {}, error => { throw error; });
  await dispatcher.start(); await dispatcher.submit("parent", "sole-writer", "Create original counter once, then finish remaining receipt");
} else if (phase === "original") {
  const row = await store.submit("parent", "sole-writer", "Finish original effect and remaining work; never repeat completed effects", "direct");
  const task = await store.claim(row.id), key = `dispatch:${task.id}:${task.token}`, manager = get(key);
  await store.intent(task.id, task.token!, `turn:${task.id}:${task.token}`, "unsafe");
  manager.appendMessage({ role: "user", content: task.input, timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture", model: "deterministic", stopReason: "toolUse", timestamp: Date.now(),
    content: [{ type: "toolCall", id: "original-effect", name: "fixture-write", arguments: { path: "counter" } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await writeFile(path.join(home!, "counter"), "original-effect\n", { flag: "wx" });
  manager.appendMessage({ role: "toolResult", toolCallId: "original-effect", toolName: "fixture-write", isError: false,
    content: [{ type: "text", text: "original-effect committed exactly once; final receipt absent" }], timestamp: Date.now() });
  await store.workerSession(task.id, task.token!, key);
  console.log(JSON.stringify({ pid: process.pid, phase, executionId: task.id }));
} else {
  await store.recover(new Map([["direct", recovery]]));
  const task = await store.claim(store.list()[0]!.id, recovery);
  harness.accept = async input => {
    if (phase === "handover-crash") throw Error("FAULT_AFTER_NEW_SESSION_REFERENCE_BEFORE_FIRST_WORKER_PROMPT");
    const key = input.sessionKey, manager = get(key);
    if (phase === "admission-finish") {
      assert.match(JSON.stringify(manager.getBranch()), /dispatcher-worker-preparation/);
      await writeFile(path.join(home!, "counter"), "original-effect\n", { flag: "wx" });
    } else assert.match(JSON.stringify(manager.getBranch()), /original-effect committed exactly once/);
    assert.equal(await readFile(path.join(home!, "counter"), "utf8"), "original-effect\n");
    manager.appendMessage({ role: "user", content: input.text, timestamp: Date.now() });
    await writeFile(path.join(home!, "remaining"), "remaining-work-complete\n", { flag: "wx" });
    await bridge.channel.send(input.replyTo!, "Remaining work completed; original effect not replayed");
  };
  try {
    const result = await bridge.strategy.execute(task, { signal: new AbortController().signal,
      checkpoint: value => store.checkpoint(task.id, task.token!, value),
      intent: (key, replay) => store.intent(task.id, task.token!, key, replay),
      workerSession: key => store.workerSession(task.id, task.token!, key),
      settleIntent: (key, result, checkpoint) => store.settleIntent(task.id, task.token!, key, result, checkpoint),
    });
    if (!["finish", "admission-finish"].includes(phase!)) throw Error("Expected injected process boundary");
    await store.complete(task.id, task.token!, result);
  } catch (error) {
    if (phase !== "handover-crash" || !(error instanceof Error) || error.message !== "FAULT_AFTER_NEW_SESSION_REFERENCE_BEFORE_FIRST_WORKER_PROMPT") throw error;
  }
  console.log(JSON.stringify({ pid: process.pid, phase, executionId: task.id, status: store.list()[0]!.status }));
}
// No dispose, checkpoint hook or Harness shutdown can accidentally persist the
// custom-only replacement after the injected fault: the child now exits.
