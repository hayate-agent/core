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

/* Reproduces live execution d2494ffb (2026-11-05): a sequential step whose worker
 * reported "STEP-STATUS: complete" three times (initial + c1 + c2) while the
 * independent validator kept answering "continue". After STEP_CONTINUATIONS the
 * strategy throws, Dispatcher.fail() records the generic "runtime-failure" and,
 * because settleIntent already cleared the intent, the child is "paused" (not
 * "blocked") with outcomes 0, prior.index 0 and settledEffect step 0.
 * The bound parent waits on it. Host supervision (reconcileBlockedDependency)
 * only considers "blocked" children and hasPendingDependency skips the parent's
 * wait recheck, so nobody owns the paused child: no assessment, no bounded
 * continuation, no actionable notice. This is the stall to fix. */

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
  let workerTurns = 0;
  const open = runtime.open.bind(runtime);
  runtime.open = async (key: string, options: OpenSessionOptions = {}) => {
    const session = await open(key, options);
    const prompt = session.prompt.bind(session);
    session.prompt = async (text: string, o: PromptOptions = {}) => {
      o.onEvent?.({ type: "execution", selection: { model: o.model ?? "p/default", thinking: o.thinking ?? "high" } } as never);
      if (options.assessmentPurpose === "supervisor") return '{"state":"continue","next":"inventory the remaining legacy executions"}';
      await prompt(text, o);
      if (key.startsWith("plan:")) return plan;
      workerTurns++;
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
    await settled;
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

test("d2494ffb: validator-exhausted step pause is not orphaned by host supervision", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paused-child-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const phase1 = await pausedLikeD2494ffb(home);
  // Exact live diagnostic shape of d2494ffb.
  const raw = JSON.parse(await readFile(phase1.file, "utf8")) as { executions: Array<Record<string, unknown>> };
  const child = raw.executions.find(e => e.id === phase1.id)!;
  assert.equal(child.status, "paused");
  assert.equal(child.diagnosticCode, "runtime-failure");
  assert.equal(child.intent, undefined);
  assert.match((child.settledEffect as { key: string }).key, /^step:.+:0:medium$/);
  const checkpoint = JSON.parse(child.checkpoint as string) as SequentialState;
  assert.equal(checkpoint.outcomes.length, 0);
  assert.equal(checkpoint.prior?.index, 0);
  assert.equal(phase1.workerTurns, 3, "initial turn + 2 bounded continuations");

  const host = await restartedHost(t, phase1.file);
  const before = await readFile(phase1.file, "utf8");
  await host.h.recoverTasks();
  await host.h.tick(); await host.h.tick();
  // No rerun of completed effects and no silent auto-resume of the child.
  assert.equal(host.runtime.sessions.size, 0);
  assert.equal(host.store.list().find(e => e.id === phase1.id)!.status, "paused");
  assert.equal(await readFile(phase1.file, "utf8"), before);
  // Required: the host keeps an actionable owner — the existing bounded independent
  // assessment runs (at most once) or an actionable notice names the paused child.
  const noticed = host.channel.sent.some(m => m.text.includes(phase1.id.slice(0, 8)));
  assert.ok(host.assessments() <= 1, "assessment must stay bounded");
  assert.ok(host.assessments() === 1 || noticed,
    `paused child ${phase1.id} orphaned: no assessment, no continuation, no notice (parent ${host.h.snapshotSessions()[0]!.task?.state})`);
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
