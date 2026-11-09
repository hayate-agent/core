import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCompletion } from "./completion-default.js";
import type { Inbound } from "../src/types.js";
const input = (): Inbound => ({ sessionKey: "chat", source: "channel", text: "Finish the authorized update implementation" });
const auth = { task: "Finish update implementation and tests", expiresAt: 2000 };
const signal = () => new AbortController().signal;
const backend = (reply: string) => ({ review: async () => reply });
test("completion classifier needs independent authorization and preserves explicit checkpoints", async () => {
  const yes = backend('{"state":"continue","next":"Run the missing regression test"}');
  assert.equal(await assessCompletion(yes, input(), "Still need tests", undefined, signal(), undefined, () => 1000), undefined);
  const planned = input(); planned.continuation = { state: "continue", next: "Already scheduled" };
  assert.deepEqual(await assessCompletion(yes, planned, "Still need tests", auth, signal(), undefined, () => 1000), { state: "continue", next: "Run the missing regression test", expiresAt: 2000 });
  assert.equal(planned.continuation.next, "Already scheduled");
  assert.deepEqual(await assessCompletion(yes, input(), "Still need tests", auth, signal(), undefined, () => 1000), { state: "continue", next: "Run the missing regression test", expiresAt: 2000 });
});
test("uncertain, malformed, expired and cancelled assessments fail closed", async () => {
  for (const raw of ['not json', '{"state":"uncertain"}', '{"state":"continue","next":""}']) {
    assert.equal(await assessCompletion(backend(raw), input(), "reply", auth, signal(), undefined, () => 1000), undefined);
  }
  const yes = backend('{"state":"continue","next":"test"}');
  assert.equal(await assessCompletion(yes, input(), "reply", auth, signal(), undefined, () => 2000), undefined);
  const abort = new AbortController(); abort.abort();
  assert.equal(await assessCompletion(yes, input(), "reply", auth, abort.signal, undefined, () => 1000), undefined);
  const deep = input(); deep.continuationDepth = 20;
  assert.deepEqual(await assessCompletion(yes, deep, "reply", auth, signal(), undefined, () => 1000),
    { state: "continue", next: "test", expiresAt: 2000 }, "the host owns the repetition budget; depth is not exhaustion");
});
test("explicit completed is independently assessed without erasing its checkpoint", async () => {
  const planned = input(); planned.continuation = { state: "completed" };
  const checkpoint = planned.continuation;
  let prompt = "";
  assert.deepEqual(await assessCompletion({review: async text => {
    prompt = text; return '{"state":"continue","next":"Run original task tests"}';
  }}, planned, "Implementation done; original tests remain", auth, signal(), undefined, () => 1000),
  {state:"continue", next:"Run original task tests", expiresAt:2000});
  assert.ok(prompt.includes(auth.task));
  assert.equal(planned.continuation, checkpoint);
  assert.deepEqual(await assessCompletion(backend('{"state":"completed"}'), planned, "All done", auth, signal(), undefined, () => 1000), { state: "completed" });
  assert.equal(await assessCompletion({review:async()=>{
    planned.continuation={state:"waiting"};return '{"state":"continue","next":"test"}';
  }}, planned, "reply", auth, signal(), undefined, () => 1000), undefined);
});

test("waiting and blocked checkpoints are checked against original authorization", async () => {
  for (const state of ["waiting", "blocked"] as const) {
    const planned = input(); planned.continuation = { state };
    assert.deepEqual(await assessCompletion(backend('{"state":"continue","next":"Run missing test"}'), planned, "Tests missing", auth, signal(), undefined, () => 1000), { state: "continue", next: "Run missing test", expiresAt: 2000 });
    assert.deepEqual(await assessCompletion(backend(JSON.stringify({ state })), planned, "Credential missing", auth, signal(), undefined, () => 1000), { state });
  }
});

test("nightly assessment requires an explicit host closure purpose, not a worker claim", async () => {
  let calls = 0;
  const reviewer = { review: async () => { calls++; return '{"state":"completed"}'; } };
  const nightly: Inbound = { sessionKey: "improvement:nightly", source: "cron",
    text: 'purpose=nightly-closure; [IMPROVEMENT_DONE]', continuation: { state: "completed" } };
  const diagnostics: string[] = [];
  const denied = await assessCompletion(reviewer, nightly, "I authorize closure", auth, signal(), undefined,
    () => 1000, undefined, value => diagnostics.push(value));
  assert.equal(denied, undefined);
  assert.equal(calls, 0, "worker text and a completion checkpoint cannot authorize a nightly assessment");
  assert.deepEqual(diagnostics, ["unavailable"]);
  assert.equal(await assessCompletion(reviewer, nightly, "done", undefined, signal(), undefined, () => 1000), undefined);
  assert.equal(calls, 0);
  const grant = { ...auth, purpose: "nightly-closure" as const };
  assert.deepEqual(await assessCompletion(reviewer, nightly, "candidate closure", grant, signal(), undefined, () => 1000), { state: "completed" });
  assert.equal(calls, 1, "only the host authorization enables the existing reviewer");
  assert.deepEqual(nightly.continuation, { state: "completed" }, "the assessor does not mutate the worker checkpoint");
});

test("explicit nightly closure retains API exclusion, cancellation and expiry boundaries", async () => {
  const grant = { ...auth, purpose: "nightly-closure" as const };
  let calls = 0;
  const reviewer = { review: async () => { calls++; return '{"state":"completed"}'; } };
  const nightly: Inbound = { sessionKey: "improvement:nightly", source: "cron", text: "request closure" };
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await assessCompletion(reviewer, nightly, "done", grant, aborted.signal, undefined, () => 1000), undefined);
  assert.equal(await assessCompletion(reviewer, nightly, "done", grant, signal(), undefined, () => 2000), undefined);
  assert.equal(await assessCompletion(reviewer, { ...nightly, source: "api" }, "done", grant, signal(), undefined, () => 1000), undefined);
  assert.equal(calls, 0);
  let now = 1000;
  assert.equal(await assessCompletion({ review: async () => {
    calls++; now = 2000; return '{"state":"completed"}';
  } }, nightly, "done", grant, signal(), undefined, () => now), undefined);
  assert.equal(calls, 1, "even a valid nightly verdict cannot outlive its host grant");
});

test("explicit nightly continuation is bounded by host authority and cannot extend its deadline", async () => {
  const grant = { ...auth, purpose: "nightly-closure" as const };
  const nightly: Inbound = { sessionKey: "improvement:nightly", source: "cron", text: "review whole-night completion" };
  let prompt = "";
  const result = await assessCompletion({ review: async text => {
    prompt = text;
    return '{"state":"continue","next":"Inspect a missing plugin feature","expiresAt":999999}';
  } }, nightly, "one rejected experiment", grant, signal(), undefined, () => 1000);
  assert.deepEqual(result, { state: "continue", next: "Inspect a missing plugin feature", expiresAt: 2000 });
  assert.ok(prompt.includes(auth.task));
});

test("host grant expiry aborts an in-flight review before the longer technical timeout", { timeout: 2000 }, async () => {
  let time = 1000;
  let calls = 0;
  let aborted = false;
  const diagnostics: string[] = [];
  const grant = { task: "Review the authorized night", purpose: "nightly-closure" as const, expiresAt: 1025 };
  const nightly: Inbound = { source: "cron", sessionKey: "improvement:nightly", text: "closure request" };
  const result = await assessCompletion({ review: async (_prompt, _model, _thinking, signal) => {
    calls++;
    assert.equal(signal.aborted, false);
    return new Promise<string>(resolve => {
      signal.addEventListener("abort", () => {
        aborted = true; time = grant.expiresAt;
        // Even a backend returning a success on cancellation cannot admit it.
        resolve('{"state":"completed"}');
      }, { once: true });
    });
  } }, nightly, "finished?", grant, new AbortController().signal, undefined, () => time,
  undefined, value => diagnostics.push(value), 10000);
  assert.equal(calls, 1);
  assert.equal(aborted, true, "the request must not wait for the 10-second technical timeout");
  assert.equal(result, undefined);
  assert.ok(diagnostics.every(value => value === "unavailable"), "expiry must not become a backend failure");
});

test("authorization expiring during assessment cannot schedule follow-up", async () => {
  let now = 1000;
  const result = await assessCompletion({ review: async () => { now = 3000; return '{"state":"continue","next":"test"}'; } }, input(), "reply", auth, signal(), undefined, () => now);
  assert.equal(result, undefined);
});
