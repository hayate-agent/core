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
  assert.equal(await assessCompletion(yes, planned, "Still need tests", auth, signal(), undefined, () => 1000), undefined);
  assert.deepEqual(await assessCompletion(yes, input(), "Still need tests", auth, signal(), undefined, () => 1000), { state: "continue", next: "Run the missing regression test", expiresAt: 2000 });
});
test("uncertain, malformed, expired, cancelled and budget-exhausted assessments fail closed", async () => {
  for (const raw of ['not json', '{"state":"uncertain"}', '{"state":"blocked"}', '{"state":"continue","next":""}']) {
    assert.equal(await assessCompletion(backend(raw), input(), "reply", auth, signal(), undefined, () => 1000), undefined);
  }
  const yes = backend('{"state":"continue","next":"test"}');
  assert.equal(await assessCompletion(yes, input(), "reply", auth, signal(), undefined, () => 2000), undefined);
  const abort = new AbortController(); abort.abort();
  assert.equal(await assessCompletion(yes, input(), "reply", auth, abort.signal, undefined, () => 1000), undefined);
  const exhausted = input(); exhausted.continuationDepth = 20;
  assert.equal(await assessCompletion(yes, exhausted, "reply", auth, signal(), undefined, () => 1000), undefined);
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
  assert.equal(await assessCompletion(backend('{"state":"completed"}'), planned, "All done", auth, signal(), undefined, () => 1000), undefined);
  assert.equal(await assessCompletion({review:async()=>{
    planned.continuation={state:"waiting"};return '{"state":"continue","next":"test"}';
  }}, planned, "reply", auth, signal(), undefined, () => 1000), undefined);
});

test("waiting and blocked checkpoints are checked against original authorization", async () => {
  for (const state of ["waiting", "blocked"] as const) {
    const planned = input(); planned.continuation = { state };
    assert.deepEqual(await assessCompletion(backend('{"state":"continue","next":"Run missing test"}'), planned, "Tests missing", auth, signal(), undefined, () => 1000), { state: "continue", next: "Run missing test", expiresAt: 2000 });
    assert.equal(await assessCompletion(backend('{"state":"blocked"}'), planned, "Credential missing", auth, signal(), undefined, () => 1000), undefined);
  }
});

test("authorization expiring during assessment cannot schedule follow-up", async () => {
  let now = 1000;
  const result = await assessCompletion({ review: async () => { now = 3000; return '{"state":"continue","next":"test"}'; } }, input(), "reply", auth, signal(), undefined, () => now);
  assert.equal(result, undefined);
});
