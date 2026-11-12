import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController } from "./improvement-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

// Regressions for the nightly closure fix. Fixture runtime only: no real model is involved.
// The validator is an explicit constructor dependency, not an ignored dynamic property.
// verdict: { verdict: "confirmed" | "rejected"; feedback?: string } ; throwing/invalid = technical failure.
type Closure = (req: { night: string; turn: number; maxTurns: number; experiments: unknown[] }) => Promise<unknown>;
const KEY = "improvement:nightly";
const receipt = (hypothesis: string, outcome = "rejected", evidence = "node --test test/x.test.ts failed 1/1; /tmp/x.json") =>
  "```improvement-experiment\n" + JSON.stringify({ execution: "performed", hypothesis, baseline: "baseline 1/1 fail", candidate: "isolated change", evidence, outcome }) + "\n```";

async function setup(t: any, answers: string[], closure?: Closure, maxTurns = 6) {
  const home = await mkdtemp(path.join(os.tmpdir(), "improvement-closure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "improvement.yaml"), `enabled: true\nmaxTurns: ${maxTurns}\ntimezone: UTC\n`);
  let n = 0;
  const runtime = new FakeRuntime(() => answers[Math.min(n++, answers.length - 1)]!);
  const harness = new Harness({ runtime, tickMs: 60000 });
  const now = () => Date.parse("2026-10-24T23:00:00Z");
  const make = () => {
    const c = new ImprovementController(home, harness, "UTC", now, closure ? async request => {
      const result = await closure(request) as { verdict?: string; feedback?: string };
      if (result?.verdict === "confirmed") return { state: "completed" };
      if (result?.verdict === "rejected" && result.feedback) return { state: "continue", next: result.feedback };
      return undefined;
    } : undefined);
    const opts = (harness as any).opts;
    opts.beforeTurn = (input: any) => c.before(input);
    opts.afterTurn = async (input: any, reply: string) => { await c.completed(input, reply); return reply; };
    return c;
  };
  const read = async () => JSON.parse(await readFile(path.join(home, "improvement/state.json"), "utf8"));
  const step = async (c: ImprovementController) => { await c.tick(); await harness.drained(); };
  t.after(() => harness.stop(1000));
  return { home, runtime, harness, make, read, step };
}

test("rejected experiment plus marker does not close the night without a verdict", async t => {
  const s = await setup(t, [receipt("h1") + "\nkein weiterer Kandidat [IMPROVEMENT_DONE]"]);
  const c = s.make();
  await s.step(c);
  assert.notEqual((await s.read()).done, true);
});

test("a later bare marker does not auto-close on an old receipt", async t => {
  const s = await setup(t, [receipt("h1", "improved"), "fertig [IMPROVEMENT_DONE]"]);
  const c = s.make();
  await s.step(c); await s.step(c);
  assert.notEqual((await s.read()).done, true);
});

test("validator rejection continues the night in the same session with concrete feedback", async t => {
  const calls: unknown[] = [];
  const s = await setup(t, [receipt("h1") + "\n[IMPROVEMENT_DONE]", receipt("h2", "improved")],
    async req => { calls.push(req); return calls.length === 1 ? { verdict: "rejected", feedback: "NEXT-CANDIDATE: plugin parity gap X" } : { verdict: "confirmed" }; });
  const c = s.make();
  await s.step(c); await s.step(c);
  const st = await s.read();
  assert.equal(st.turns, 2);
  assert.match(s.runtime.sessions.get(KEY)!.prompts.at(-1)!, /NEXT-CANDIDATE: plugin parity gap X/);
  assert.equal(s.runtime.sessions.size, 1);
});

test("genuinely exhausted work confirmed by the validator closes durably", async t => {
  let calls = 0;
  const s = await setup(t, [receipt("h1") + "\n[IMPROVEMENT_DONE]"], async () => { calls++; return { verdict: "confirmed" }; });
  await s.step(s.make());
  assert.equal(calls, 1);
  assert.equal((await s.read()).done, true);
  const restarted = s.make(); await s.step(restarted);
  assert.equal((await s.read()).turns, 1); // closed night stays closed after restart
});

test("technical validation failure is bounded, diagnosed and never completes", async t => {
  let calls = 0;
  const s = await setup(t, [receipt("h1") + "\n[IMPROVEMENT_DONE]", receipt("h2") + "\n[IMPROVEMENT_DONE]", receipt("h3") + "\n[IMPROVEMENT_DONE]",
    receipt("h4") + "\n[IMPROVEMENT_DONE]", receipt("h5") + "\n[IMPROVEMENT_DONE]"], async () => { calls++; throw Error("validator unreachable"); }, 5);
  const c = s.make();
  for (let i = 0; i < 5; i++) await s.step(c);
  const st = await s.read();
  assert.notEqual(st.done, true);
  assert.ok(calls <= 3, `validator retried ${calls} times`);
  assert.ok(st.results.some((r: string) => /validator unreachable|Validierung/.test(r)));
});

test("crash/restart between verdict and feedback does not re-run the validator or double the feedback", async t => {
  let calls = 0;
  const s = await setup(t, [receipt("h1") + "\n[IMPROVEMENT_DONE]", receipt("h2", "improved")],
    async () => { calls++; return { verdict: "rejected", feedback: "FEEDBACK-ONCE" }; });
  await s.step(s.make());
  assert.equal(calls, 1);
  await s.step(s.make()); // fresh controller over the same persisted state
  assert.equal(calls, 1);
  const prompts = s.runtime.sessions.get(KEY)!.prompts;
  assert.equal(prompts.filter(p => p.includes("FEEDBACK-ONCE")).length, 1);
});

test("aborting the originating turn prevents adoption of a late completion verdict", { timeout: 10000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-closure-abort-"));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
  const turn = new AbortController();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let receivedSignal: AbortSignal | undefined;
  let calls = 0;
  const harness = new Harness({ runtime: new FakeRuntime(() => receipt("abort-case") + "\n[IMPROVEMENT_DONE]"), tickMs: 60000 });
  const controller = new ImprovementController(home, harness, "UTC", () => Date.parse("2026-10-24T23:00:00Z"), async request => {
    calls++;
    receivedSignal = request.signal;
    enter();
    // Deliberately emulate a backend that returns despite cancellation.
    await held;
    return { state: "completed" };
  });
  const opts = (harness as any).opts;
  opts.beforeTurn = (input: any) => controller.before(input);
  opts.afterTurn = async (input: any, reply: string) => {
    await controller.completed(input, reply, turn.signal);
    return reply;
  };
  try {
    await controller.tick();
    await entered;
    turn.abort();
    release();
    await harness.drained();
    const state = JSON.parse(await readFile(path.join(home, "improvement/state.json"), "utf8"));
    assert.notEqual(state.done, true, "a late verdict cannot close an aborted turn");
    assert.equal(state.closureFeedback, undefined, "cancellation cannot admit a continuation either");
    assert.equal(state.closureFailures ?? 0, 0, "operator cancellation is not a technical retry");
    assert.equal(calls, 1);
    assert.equal(receivedSignal, turn.signal, "the validator receives the originating turn signal");
    assert.equal(receivedSignal?.aborted, true);
    assert.equal(state.turns, 1, "the already reserved turn is not refunded");
    assert.equal(state.experiments.length, 1, "completed experiment evidence survives cancellation");
  } finally {
    release();
    await harness.stop(1000);
    await rm(home, { recursive: true, force: true });
  }
});

test("window expiry while the validator is held discards its late completion", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-window-expiry-"));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
  let now = Date.parse("2026-10-25T04:59:00Z");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let checks = 0, turns = 0;
  const harness = new Harness({ runtime: new FakeRuntime(() => {
    turns++; return receipt("window-case") + "\n[IMPROVEMENT_DONE]";
  }), tickMs: 60000 });
  const controller = new ImprovementController(home, harness, "UTC", () => now, async () => {
    checks++; enter(); await held; return { state: "completed" };
  });
  const opts = (harness as any).opts;
  opts.beforeTurn = (input: any) => controller.before(input);
  opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
  try {
    await controller.tick(); await entered;
    now = Date.parse("2026-10-25T05:00:00Z");
    release(); await harness.drained();
    const read = async () => JSON.parse(await readFile(path.join(home, "improvement/state.json"), "utf8"));
    const state = await read();
    assert.notEqual(state.done, true, "expiry cannot turn a late validator reply into successful completion");
    assert.equal(state.closureFeedback, undefined);
    assert.equal(state.closureFailures ?? 0, 0, "window expiry is not a technical failure");
    assert.equal(state.turns, 1);
    assert.equal(state.experiments.length, 1);
    assert.equal(state.experiments[0].execution, "performed");
    assert.equal(state.pending, undefined);
    const restarted = new ImprovementController(home, harness, "UTC", () => now, async () => {
      throw Error("expired night must not request another assessment");
    });
    await restarted.tick(); await harness.drained();
    assert.equal(checks, 1); assert.equal(turns, 1);
    assert.equal((await read()).turns, 1);
    assert.equal(harness.pendingInputs().length, 0);
  } finally {
    release(); await harness.stop(1000);
    await rm(home, { recursive: true, force: true });
  }
});

test("disabling policy during validation discards a late verdict without losing performed work", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-policy-disable-"));
  const file = path.join(home, "improvement.yaml");
  await writeFile(file, "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let checks = 0, turns = 0;
  const harness = new Harness({ runtime: new FakeRuntime(() => {
    turns++; return receipt("disabled-policy-case") + "\n[IMPROVEMENT_DONE]";
  }), tickMs: 60000 });
  const now = () => Date.parse("2026-10-24T23:00:00Z");
  const controller = new ImprovementController(home, harness, "UTC", now, async () => {
    checks++; enter(); await held; return { state: "completed" };
  });
  const opts = (harness as any).opts;
  opts.beforeTurn = (input: any) => controller.before(input);
  opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
  const read = async () => JSON.parse(await readFile(path.join(home, "improvement/state.json"), "utf8"));
  try {
    await controller.tick(); await entered;
    assert.equal((await read()).turns, 1, "the turn reservation is durable before the policy change");
    await writeFile(file, "enabled: false\nmaxTurns: 6\ntimezone: UTC\n");
    release(); await harness.drained();
    const state = await read();
    assert.equal(state.done, false);
    assert.equal(state.closureFeedback, undefined);
    assert.equal(state.closureFailures ?? 0, 0, "policy disable is not a technical failure");
    assert.equal(state.turns, 1);
    assert.equal(state.experiments.length, 1);
    assert.equal(state.experiments[0].execution, "performed");
    assert.equal(state.experiments[0].hypothesis, "disabled-policy-case");
    assert.equal(state.pending, undefined);
    await controller.tick(); await harness.drained();
    const restarted = new ImprovementController(home, harness, "UTC", now, async () => {
      throw Error("disabled policy must not request another assessment");
    });
    await restarted.tick(); await harness.drained();
    assert.equal(turns, 1); assert.equal(checks, 1);
    assert.deepEqual(await read(), state, "disabled ticks and reload leave retained evidence unchanged");
    assert.equal(harness.pendingInputs().length, 0);
  } finally {
    release(); await harness.stop(1000);
    await rm(home, { recursive: true, force: true });
  }
});

for (const limit of [1, 2] as const) {
  test(`late closure with reserved turn 2 and reduced budget ${limit}`, { timeout: 10000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nightly-budget-change-"));
    const policy = (maxTurns: number) => `enabled: true\nmaxTurns: ${maxTurns}\ntimezone: UTC\n`;
    await writeFile(path.join(home, "improvement.yaml"), policy(6));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let turns = 0, checks = 0;
    const harness = new Harness({ runtime: new FakeRuntime(() => {
      turns++;
      return receipt(`budget-${turns}`) + (turns === 2 ? "\n[IMPROVEMENT_DONE]" : "");
    }), tickMs: 60000 });
    const controller = new ImprovementController(home, harness, "UTC", () => Date.parse("2026-10-24T23:00:00Z"), async request => {
      checks++;
      assert.equal(request.turn, 2);
      assert.equal(request.maxTurns, 6);
      enter(); await held; return { state: "completed" };
    });
    const opts = (harness as any).opts;
    opts.beforeTurn = (input: any) => controller.before(input);
    opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
    const read = async () => JSON.parse(await readFile(path.join(home, "improvement/state.json"), "utf8"));
    try {
      await controller.tick(); await harness.drained();
      assert.equal((await read()).turns, 1);
      await controller.tick(); await entered;
      assert.equal((await read()).turns, 2, "the second turn is already durably reserved");
      await writeFile(path.join(home, "improvement.yaml"), policy(limit));
      release(); await harness.drained();
      const state = await read();
      assert.equal(state.done, limit === 2, "only a turn still inside the reduced budget may close");
      assert.equal(state.turns, 2, "budget changes do not refund a consumed turn");
      assert.equal(state.experiments.length, 2, "performed experiments are retained");
      assert.equal(state.closureFailures ?? 0, 0, "budget exhaustion is not a technical failure");
      assert.equal(state.closureFeedback, undefined);
      assert.equal(state.pending, undefined);
      await controller.tick(); await harness.drained();
      assert.equal(turns, 2); assert.equal(checks, 1);
    } finally {
      release(); await harness.stop(1000);
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("an uncommitted continue at the failure limit retains consumed attempts without replay", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-continue-recovery-"));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
  await mkdir(path.join(home, "improvement"));
  const file = path.join(home, "improvement/state.json");
  const experiment = { execution: "performed", hypothesis: "retained", baseline: "measured", candidate: "tried",
    evidence: "test output", outcome: "inconclusive" };
  await writeFile(file, JSON.stringify({ version: 1, night: "2026-10-24", turns: 2, pending: "turn-2",
    results: [], experiments: [experiment], recentHypotheses: ["retained"], closureFailures: 3,
    closureAssessment: { night: "2026-10-24", inputId: "turn-2", turn: 2, phase: "decided",
      verdict: { state: "continue", next: "Inspect the next independent plugin candidate" } } }));
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000 });
  let reviews = 0;
  const queued: any[] = [];
  h.enqueue = input => { queued.push(input); };
  try {
    const recovered = new ImprovementController(home, h, "UTC", () => Date.parse("2026-10-24T23:00:00Z"), async () => {
      reviews++; throw Error("reviewer replay forbidden");
    });
    await recovered.tick();
    const state = JSON.parse(await readFile(file, "utf8"));
    assert.equal(state.closureFailures, 3, "a saved but uncommitted verdict cannot reset the failure budget");
    assert.equal(state.closureFeedback, undefined, "only a fully committed admission may supply feedback");
    assert.equal(state.turns, 2, "the consumed working turns are not refunded");
    assert.deepEqual(state.experiments, [experiment]);
    assert.deepEqual(state.recentHypotheses, ["retained"]);
    assert.equal(state.closureAssessment, undefined);
    assert.notEqual(state.done, true);
    assert.equal(reviews, 0);
    assert.equal(runtime.opened.length, 0);
    assert.equal(queued.length, 0, "the consumed failure limit remains binding");
    assert.equal(state.pending, undefined);
  } finally {
    await h.stop(1000); await rm(home, { recursive: true, force: true });
  }
});

for (const verdict of [{ state: "completed" }, { state: "continue", next: "CANCELLED-VERDICT-NEXT" }] as const) {
  test(`restart cannot adopt ${verdict.state} returned after originating-turn cancellation`, { timeout: 10000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nightly-cancel-crash-"));
    await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
    await mkdir(path.join(home, "improvement"));
    const file = path.join(home, "improvement/state.json");
    await writeFile(file, JSON.stringify({ version: 1, night: "2026-10-24", turns: 1,
      pending: "turn-1", results: [], experiments: [], recentHypotheses: [] }));
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000 });
    const now = () => Date.parse("2026-10-24T23:00:00Z");
    const turn = new AbortController();
    let calls = 0;
    const controller = new ImprovementController(home, h, "UTC", now, async () => {
      calls++; turn.abort(); return verdict;
    });
    try {
      await (controller as any).load();
      const save = (controller as any).save.bind(controller);
      (controller as any).save = async () => {
        await save();
        if ((controller as any).state.closureAssessment?.phase === "decided") throw Error("crash after verdict persistence");
      };
      await assert.rejects(controller.completed({ id: "turn-1", sessionKey: KEY, source: "cron", text: "Authorized nightly work" },
        receipt("cancelled-assessment") + "\n[IMPROVEMENT_DONE]", turn.signal), /crash after verdict persistence/);
      const persisted = JSON.parse(await readFile(file, "utf8"));
      assert.equal(persisted.turns, 1);
      assert.equal(persisted.experiments.length, 1);
      assert.equal(persisted.closureAssessment.cancelled, true, "revocation survives process loss");
      assert.equal(persisted.closureAssessment.verdict, undefined, "cancelled results are not persisted as usable decisions");
      assert.equal(calls, 1);
      const queued: any[] = [];
      h.enqueue = input => { queued.push(input); };
      const recovered = new ImprovementController(home, h, "UTC", now, async () => { throw Error("reviewer replay forbidden"); });
      await recovered.tick();
      const final = JSON.parse(await readFile(file, "utf8"));
      assert.notEqual(final.done, true, "a cancelled turn cannot close the night after restart");
      assert.equal(final.closureFeedback, undefined, "a cancelled verdict cannot authorize its proposed continuation");
      assert.equal(final.turns, 1, "consumed turns remain consumed");
      assert.deepEqual(final.experiments, persisted.experiments);
      assert.equal(final.closureAssessment, undefined);
      assert.equal(calls, 1); assert.equal(runtime.opened.length, 0);
      assert.ok(queued.every(input => !input.text.includes("CANCELLED-VERDICT-NEXT")));
    } finally {
      await h.stop(1000); await rm(home, { recursive: true, force: true });
    }
  });
}

test("abort during suspended decision save cannot become completion after restart", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-abort-save-"));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
  await mkdir(path.join(home, "improvement"));
  const file = path.join(home, "improvement/state.json");
  await writeFile(file, JSON.stringify({ version: 1, night: "2026-10-24", turns: 1,
    pending: "turn-1", results: [], experiments: [], recentHypotheses: [] }));
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000 });
  const now = () => Date.parse("2026-10-24T23:00:00Z");
  const turn = new AbortController();
  let entered!: () => void, release!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const c = new ImprovementController(home, h, "UTC", now, async () => { calls++; return { state: "completed" }; });
  try {
    await (c as any).load();
    const save = (c as any).save.bind(c);
    (c as any).save = async () => {
      if ((c as any).state.closureAssessment?.phase !== "decided") return save();
      // Capture the write snapshot before suspending, just like save() serializes
      // state before awaiting writeFileDurable(). Abort cannot change these bytes.
      const snapshot = JSON.stringify((c as any).state);
      entered(); await held;
      await writeFile(file, snapshot);
      throw Error("process loss after suspended decision save");
    };
    const completing = c.completed({ id: "turn-1", sessionKey: KEY, source: "cron", text: "Authorized nightly work" },
      receipt("save-race") + "\n[IMPROVEMENT_DONE]", turn.signal);
    const failed = assert.rejects(completing, /process loss after suspended decision save/);
    await saving;
    turn.abort(); release(); await failed;
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.turns, 1); assert.equal(persisted.experiments.length, 1);
    const queued: any[] = []; h.enqueue = input => { queued.push(input); };
    const restarted = new ImprovementController(home, h, "UTC", now, async () => { throw Error("assessment replay forbidden"); });
    await restarted.tick();
    const final = JSON.parse(await readFile(file, "utf8"));
    assert.notEqual(final.done, true, "cancellation during the write must fence the stored decision");
    assert.equal(final.closureFeedback, undefined);
    assert.equal(final.turns, 1); assert.deepEqual(final.experiments, persisted.experiments);
    assert.equal(calls, 1); assert.equal(runtime.opened.length, 0);
  } finally {
    release(); await h.stop(1000); await rm(home, { recursive: true, force: true });
  }
});

test("abort while final completion snapshot is awaiting publication cannot persist success", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-final-save-abort-"));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
  await mkdir(path.join(home, "improvement"));
  const file = path.join(home, "improvement/state.json");
  await writeFile(file, JSON.stringify({ version: 1, night: "2026-10-24", turns: 1,
    pending: "turn-1", results: [], experiments: [], recentHypotheses: [] }));
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000 });
  const now = () => Date.parse("2026-10-24T23:00:00Z");
  const abort = new AbortController();
  let enter!: () => void, release!: () => void;
  const publishing = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let reviews = 0;
  const controller = new ImprovementController(home, h, "UTC", now, async () => {
    reviews++; return { state: "completed" };
  });
  try {
    await (controller as any).load();
    const save = (controller as any).save.bind(controller);
    (controller as any).save = async (guard?: () => void) => {
      const state = (controller as any).state;
      if (!state.done || state.closureAssessment) return save(guard);
      // Exercise the real durable writer after its staged file has been fsynced,
      // but before the guarded rename submits the final state for publication.
      return save(async () => {
        enter(); await held;
        assert.ok(guard, "final save must supply a publication guard");
        guard();
      });
    };
    const completed = controller.completed({ id: "turn-1", source: "cron", sessionKey: KEY, text: "Authorized nightly work" },
      receipt("final-save-case") + "\n[IMPROVEMENT_DONE]", abort.signal);
    const failure = assert.rejects(completed, /Nightly completion commit cancelled/);
    await publishing;
    abort.abort(); release(); await failure;
    const persisted = JSON.parse(await readFile(file, "utf8"));
    const recovered = new ImprovementController(home, h, "UTC", now, async () => { throw Error("review replay forbidden"); });
    const queued: any[] = []; h.enqueue = input => { queued.push(input); };
    await recovered.tick();
    const final = JSON.parse(await readFile(file, "utf8"));
    assert.notEqual(final.done, true, "aborting before publication cannot leave a successful completion");
    assert.equal(final.turns, 1);
    assert.equal(final.experiments.length, 1);
    assert.deepEqual(final.experiments, persisted.experiments);
    assert.equal(final.closureFeedback, undefined);
    assert.equal(reviews, 1); assert.equal(runtime.opened.length, 0);
  } finally {
    release(); await h.stop(1000); await rm(home, { recursive: true, force: true });
  }
});

for (const publication of ["before-rename", "after-rename"] as const) {
  test(`final-save failure ${publication}: existing and restarted controllers match published state`, { timeout: 10000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nightly-final-write-error-"));
    await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
    await mkdir(path.join(home, "improvement"));
    const file = path.join(home, "improvement/state.json");
    await writeFile(file, JSON.stringify({ version: 1, night: "2026-10-24", turns: 1,
      pending: "turn-1", results: [], experiments: [], recentHypotheses: [] }));
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000 });
    const now = () => Date.parse("2026-10-24T23:00:00Z");
    let reviews = 0;
    const controller = new ImprovementController(home, h, "UTC", now, async () => {
      reviews++; return { state: "completed" };
    });
    try {
      await (controller as any).load();
      const save = (controller as any).save.bind(controller);
      (controller as any).save = async (guard?: () => void) => {
        const state = (controller as any).state;
        if (!state.done || state.closureAssessment) return save(guard);
        if (publication === "after-rename") {
          // The real atomic writer has published the new file. An error reported
          // afterwards models a failing directory sync, not an absent rename.
          await save(guard);
        }
        throw Object.assign(new Error(`injected ${publication} write failure`), { code: "EIO" });
      };
      const input = { id: "turn-1", source: "cron" as const, sessionKey: KEY, text: "Authorized nightly work" };
      const reply = receipt("write-error-case") + "\n[IMPROVEMENT_DONE]";
      await assert.rejects(controller.completed(input, reply), /injected .* write failure/);
      const disk = JSON.parse(await readFile(file, "utf8"));
      assert.equal(disk.turns, 1);
      assert.equal(disk.experiments.length, 1);
      assert.equal(disk.done === true, publication === "after-rename");
      if (publication === "before-rename") {
        assert.equal(disk.closureAssessment.phase, "decided");
        assert.equal(disk.closureFailures, 1);
        assert.equal(disk.pending, "turn-1");
      } else {
        assert.equal(disk.closureAssessment, undefined);
        assert.equal(disk.pending, undefined);
      }
      let replayedReviews = 0;
      const restarted = new ImprovementController(home, h, "UTC", now, async () => {
        replayedReviews++; throw Error("reviewer replay forbidden");
      });
      await (restarted as any).load();
      assert.deepEqual((restarted as any).state, disk, "restart reconstructs the actually published snapshot");
      assert.deepEqual(JSON.parse(JSON.stringify((controller as any).state)), disk,
        "the existing controller must not retain an unpersisted successful admission");
      assert.equal(reviews, 1);
      assert.equal(replayedReviews, 0);
      assert.equal(runtime.opened.length, 0);
      assert.equal(h.pendingInputs().length, 0);
    } finally {
      await h.stop(1000); await rm(home, { recursive: true, force: true });
    }
  });
}

for (const crashPhase of ["claimed", "decided"] as const) {
  test(`crash after durable ${crashPhase} closure does not replay the assessment or worker`, { timeout: 10000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nightly-claim-crash-"));
    await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
    await mkdir(path.join(home, "improvement"));
    const file = path.join(home, "improvement/state.json");
    await writeFile(file, JSON.stringify({ version: 1, night: "2026-10-24", turns: 1,
      pending: "turn-1", results: [], experiments: [], recentHypotheses: [] }));
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000 });
    const now = () => Date.parse("2026-10-24T23:00:00Z");
    let calls = 0;
    const controller = new ImprovementController(home, h, "UTC", now, async () => {
      calls++; return { state: "completed" };
    });
    try {
      await (controller as any).load();
      const save = (controller as any).save.bind(controller);
      (controller as any).save = async () => {
        await save();
        if ((controller as any).state.closureAssessment?.phase === crashPhase) throw Error("simulated process loss");
      };
      await assert.rejects(controller.completed({ id: "turn-1", sessionKey: KEY, source: "cron", text: "Authorized nightly work" },
        receipt("persisted-experiment") + "\n[IMPROVEMENT_DONE]"), /simulated process loss/);
      const persisted = JSON.parse(await readFile(file, "utf8"));
      assert.equal(persisted.closureAssessment.phase, crashPhase);
      assert.equal(persisted.closureFailures, 1);
      assert.equal(persisted.experiments.length, 1);
      assert.equal(persisted.turns, 1);
      assert.equal(calls, crashPhase === "claimed" ? 0 : 1);
      const recovered = new ImprovementController(home, h, "UTC", now, async () => { throw Error("assessment replay forbidden"); });
      // Prevent starting a new working turn, while allowing decision reconciliation.
      const enqueue = h.enqueue.bind(h);
      h.enqueue = () => {};
      await recovered.tick();
      h.enqueue = enqueue;
      const final = JSON.parse(await readFile(file, "utf8"));
      assert.equal(final.closureAssessment, undefined);
      assert.equal(final.experiments.length, 1);
      assert.equal(final.turns, 1);
      assert.notEqual(final.done, true, "neither a claim nor an uncommitted decision authorizes completion");
      assert.equal(final.closureFeedback, undefined);
      assert.equal(final.closureFailures, 1, "recovery preserves the consumed assessment attempt");
      assert.equal(runtime.opened.length, 0);
    } finally {
      await h.stop(1000); await rm(home, { recursive: true, force: true });
    }
  });
}

test("no-experiment guard stays an honest failure and never consults the validator", async t => {
  let calls = 0;
  const s = await setup(t, ["nichts [IMPROVEMENT_DONE]"], async () => { calls++; return { verdict: "confirmed" }; });
  const c = s.make();
  for (let i = 0; i < 3; i++) await s.step(c);
  const st = await s.read();
  assert.equal(st.done, true);
  assert.equal(calls, 0);
  assert.match(st.results.at(-1), /Nachtlauf fehlgeschlagen/);
});

test("an inherited 'awaiting worker' status is not a productive experiment", async t => {
  const s = await setup(t, [receipt("h-wait", "inconclusive", "awaiting worker result; status only, no test run").replace('"execution":"performed"', '"execution":"pending"')], undefined, 6);
  const c = s.make();
  await s.step(c);
  const st = await s.read();
  assert.equal(st.experiments.length, 0);
  assert.equal(st.noExperimentTurns, 1);
});
