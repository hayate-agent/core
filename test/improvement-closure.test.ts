import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController } from "./improvement-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

// Regressions for the nightly closure fix. Fixture runtime only: no real model is involved.
// Proposed seam under test: `controller.closure(request) => verdict` (independent semantic validator).
// verdict: { verdict: "confirmed" | "rejected"; feedback?: string } ; throwing/invalid = technical failure.
type Closure = (req: { night: string; turn: number; maxTurns: number; experiments: unknown[] }) => Promise<unknown>;
const KEY = "improvement:nightly";
const receipt = (hypothesis: string, outcome = "rejected", evidence = "node --test test/x.test.ts failed 1/1; /tmp/x.json") =>
  "```improvement-experiment\n" + JSON.stringify({ hypothesis, baseline: "baseline 1/1 fail", candidate: "isolated change", evidence, outcome }) + "\n```";

async function setup(t: any, answers: string[], closure?: Closure, maxTurns = 6) {
  const home = await mkdtemp(path.join(os.tmpdir(), "improvement-closure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "improvement.yaml"), `enabled: true\nmaxTurns: ${maxTurns}\ntimezone: UTC\n`);
  let n = 0;
  const runtime = new FakeRuntime(() => answers[Math.min(n++, answers.length - 1)]!);
  const harness = new Harness({ runtime, tickMs: 60000 });
  const now = () => Date.parse("2026-10-24T23:00:00Z");
  const make = () => {
    const c = new ImprovementController(home, harness, "UTC", now);
    if (closure) (c as any).closure = closure;
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
  const s = await setup(t, [receipt("h1") + " [IMPROVEMENT_DONE]", receipt("h2", "improved")],
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
  const s = await setup(t, [receipt("h1") + " [IMPROVEMENT_DONE]"], async () => { calls++; return { verdict: "confirmed" }; });
  await s.step(s.make());
  assert.equal(calls, 1);
  assert.equal((await s.read()).done, true);
  const restarted = s.make(); await s.step(restarted);
  assert.equal((await s.read()).turns, 1); // closed night stays closed after restart
});

test("technical validation failure is bounded, diagnosed and never completes", async t => {
  let calls = 0;
  const s = await setup(t, [receipt("h1") + " [IMPROVEMENT_DONE]", receipt("h2") + " [IMPROVEMENT_DONE]", receipt("h3") + " [IMPROVEMENT_DONE]",
    receipt("h4") + " [IMPROVEMENT_DONE]", receipt("h5") + " [IMPROVEMENT_DONE]"], async () => { calls++; throw Error("validator unreachable"); }, 5);
  const c = s.make();
  for (let i = 0; i < 5; i++) await s.step(c);
  const st = await s.read();
  assert.notEqual(st.done, true);
  assert.ok(calls <= 3, `validator retried ${calls} times`);
  assert.ok(st.results.some((r: string) => /validator unreachable|Validierung/.test(r)));
});

test("crash/restart between verdict and feedback does not re-run the validator or double the feedback", async t => {
  let calls = 0;
  const s = await setup(t, [receipt("h1") + " [IMPROVEMENT_DONE]", receipt("h2", "improved")],
    async () => { calls++; return { verdict: "rejected", feedback: "FEEDBACK-ONCE" }; });
  await s.step(s.make());
  assert.equal(calls, 1);
  await s.step(s.make()); // fresh controller over the same persisted state
  assert.equal(calls, 1);
  const prompts = s.runtime.sessions.get(KEY)!.prompts;
  assert.equal(prompts.filter(p => p.includes("FEEDBACK-ONCE")).length, 1);
});

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
  const s = await setup(t, [receipt("h-wait", "inconclusive", "awaiting worker result; status only, no test run")], undefined, 6);
  const c = s.make();
  await s.step(c);
  const st = await s.read();
  assert.equal(st.experiments.length, 0);
  assert.equal(st.noExperimentTurns, 1);
});
