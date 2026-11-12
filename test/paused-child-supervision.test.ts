import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Dispatcher } from "../src/dispatcher.js";
import type { SequentialState } from "../src/dispatcher-sequential.js";
import { ExecutionStore } from "../src/execution.js";
import { Harness, type DurableTask } from "../src/harness.js";
import type { ModelRoles } from "../src/model-roles.js";
import type { OpenSessionOptions, PromptOptions } from "../src/types.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

/* Reproduces the paused-child diagnostic shape of live execution d2494ffb.
 * Successful validator continuations no longer exhaust a fixed budget. Instead,
 * five independent continuations precede a genuine technical validator failure.
 * The settled step is paused with no outcome; the bound parent must retain an
 * actionable owner without replaying effects or silently resuming the child. */

const roles: ModelRoles = { enabled: true, roles: {
  reviewer: { model: "p/review", thinking: "off" }, dispatcher: { model: "p/disp", thinking: "low" },
  simple: { model: "p/cheap", thinking: "off" }, medium: { model: "p/mid", thinking: "medium" }, high: { model: "p/top", thinking: "high" },
} };
const plan = JSON.stringify({ steps: [["preflight inventory", "medium"], ["rollout", "medium"]]
  .map(([task, role]) => ({ task, role, reason: "r", evidence: `evidence of ${task}` })) });
const SESSION = "mem:room1";
const ORIGINAL = "Fleet rollout of the verified fix";

/** Phase 1: real Harness + DispatcherRuntime + sequential strategy drive the child to the live pause. */
async function pausedLikeD2494ffb(home: string) {
  const file = path.join(home, "executions.json");
  const runtime = new FakeRuntime() as FakeRuntime & { modelPreflight: (ref: string) => Promise<{ available: boolean; thinkingSupported: boolean }> };
  runtime.modelPreflight = async () => ({ available: true, thinkingSupported: true });
  let workerTurns = 0; let continues = 0;
  const open = runtime.open.bind(runtime);
  runtime.open = async (key: string, options: OpenSessionOptions = {}) => {
    const session = await open(key, options);
    const prompt = session.prompt.bind(session);
    session.prompt = async (text: string, o: PromptOptions = {}) => {
      o.onEvent?.({ type: "execution", selection: { model: o.model ?? "p/default", thinking: o.thinking ?? "high" } } as never);
      if (options.assessmentPurpose === "supervisor") return ++continues <= 5
        ? `{"state":"continue","next":"inventory the remaining legacy executions (${continues})"}`
        : "technical validator failure";
      await prompt(text, o);
      if (key.startsWith("plan:")) return plan;
      workerTurns++;
      o.onEvent?.({ type: "tool", phase: "start", name: "read", callId: `receipt${workerTurns}`, detail: "inventory" } as never);
      o.onEvent?.({ type: "tool", phase: "end", name: "read", callId: `receipt${workerTurns}`, detail: `verified inventory receipt ${workerTurns}` } as never);
      return "inventory recorded\nSTEP-STATUS: complete";
    };
    return session;
  };
  const store = new ExecutionStore(file); await store.load();
  let bridge!: DispatcherRuntime;
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", beforeExecution: input => bridge.beforeTurn(input.sessionKey) });
  harness.onStateChange = async () => {};
  bridge = new DispatcherRuntime(harness, store, undefined, () => ({ config: roles, defaults: { model: "p/default", thinking: "high" } }));
  harness.addChannel(bridge.channel);
  let settle!: () => void; const settled = new Promise<void>(r => { settle = r; });
  const dispatcher = new Dispatcher(store, bridge.sequential, 1, async event => {
    if (event.type === "result" || (event.type === "status" && ["blocked", "paused"].includes(event.status ?? ""))) settle();
  }, () => {});
  try {
    await dispatcher.start();
    const child = await dispatcher.submitScheduled(SESSION, "fleet-rollout", ORIGINAL, { taskId: "parent", depth: 0, original: ORIGINAL });
    await dispatcher.waitForExecution(child.id);
    await dispatcher.flushEvents();
    return { file, id: child.id, workerTurns };
  } finally { await dispatcher.stop(); await harness.stop(1000); }
}

/** Phase 2: restarted host with the bound parent waiting on the dispatcher, as in state.json. */
async function restartedHost(t: import("node:test").TestContext, file: string) {
  const store = new ExecutionStore(file); await store.load();
  const runtime = new FakeRuntime();
  let assessments = 0;
  const channel = new MemoryChannel();
  const h = new Harness({ runtime, executionStore: store, now: () => 10_000, tickMs: 60000,
    completionCheck: async () => { assessments++; return { state: "blocked" }; } });
  h.addChannel(channel);
  h.onStateChange = async () => {};
  const parent: DurableTask = { id: "parent", original: ORIGINAL, state: "waiting", depth: 0,
    next: "Dispatcher owns the fleet rollout; recheck its outcome",
    wait: { reason: "The dispatcher owns the authorized fleet rollout.", nextAt: 1_000, deadline: 1_793_995_200_000 } };
  h.restoreSessions([{ key: SESSION, task: parent, replyTo: { channel: "mem", target: "room1" } }]);
  t.after(() => h.stop(0));
  return { h, store, channel, runtime, assessments: () => assessments };
}

test("d2494ffb: technical validator failure after five continuations keeps a durable scheduler owner", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paused-child-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const phase1 = await pausedLikeD2494ffb(home);
  // Exact live diagnostic shape of d2494ffb.
  const raw = JSON.parse(await readFile(phase1.file, "utf8")) as { executions: Array<Record<string, unknown>> };
  const child = raw.executions.find(e => e.id === phase1.id)!;
  assert.equal(child.status, "ready");
  assert.ok(child.assessmentRetryAt);
  assert.equal(child.diagnosticCode, undefined);
  assert.match((child.intent as { key: string }).key, /^step:.+:0:medium$/);
  const checkpoint = JSON.parse(child.checkpoint as string) as SequentialState;
  assert.equal(checkpoint.outcomes.length, 0);
  assert.equal(checkpoint.assessment?.index, 0);
  assert.equal(checkpoint.assessment?.diagnostic, "invalid_response");
  assert.equal(phase1.workerTurns, 6, "initial turn + five successful continuations before technical failure");

  const host = await restartedHost(t, phase1.file);
  const before = await readFile(phase1.file, "utf8");
  await host.h.recoverTasks();
  await host.h.tick(); await host.h.tick();
  // No rerun of completed effects and no silent auto-resume of the child.
  assert.equal(host.runtime.sessions.size, 0);
  assert.equal(host.store.list().find(e => e.id === phase1.id)!.status, "ready");
  assert.equal(await readFile(phase1.file, "utf8"), before);
  // The dispatcher already owns the persisted retry. No second parent assessor.
  assert.equal(host.assessments(), 0);
  assert.equal(host.h.pendingInputs().length, 0);
  assert.equal(host.h.snapshotSessions()[0]!.task?.state, "waiting");
});

test("explicit manual pause and open question stay binding for host supervision", async t => {
  for (const kind of ["manual-pause", "question"] as const) {
    const home = await mkdtemp(path.join(os.tmpdir(), "paused-binding-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const file = path.join(home, "executions.json");
    const store = new ExecutionStore(file); await store.load();
    const child = await store.submit(SESSION, "req", ORIGINAL, "sequential", 1, { taskId: "parent", depth: 0, original: ORIGINAL });
    const claimed = await store.claim(child.id);
    if (kind === "manual-pause") await store.control(child.id, "pause");
    else await store.ask(child.id, claimed.token!, "Which target?");
    const host = await restartedHost(t, file);
    await host.h.recoverTasks(); await host.h.tick();
    assert.equal(host.assessments(), 0, kind);
    assert.equal(host.h.pendingInputs().length, 0, kind);
    assert.equal(host.store.list()[0]!.status, "paused", kind);
  }
});
