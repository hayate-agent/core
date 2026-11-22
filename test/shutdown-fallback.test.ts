import { test } from "node:test";
import assert from "node:assert/strict";
import { ShutdownDeadline } from "../src/shutdown-deadline.js";

test("timeout fallback errors reject the wait instead of escaping the timer", async () => {
  const deadline = new ShutdownDeadline(1000, () => {});
  const error = Error("fallback failed");
  try {
    await assert.rejects(deadline.wait(new Promise<never>(() => {}), 1, () => { throw error; }), value => value === error);
  } finally { deadline.close(); }
});

test("expired budget also propagates fallback failure", async () => {
  let now = 0;
  const deadline = new ShutdownDeadline(1000, () => {}, () => now);
  now = 1001;
  try {
    await assert.rejects(deadline.wait(new Promise<never>(() => {}), 1000, () => { throw Error("expired"); }), /expired/);
  } finally { deadline.close(); }
});

test("successful fallback and settled work retain their results", async () => {
  const deadline = new ShutdownDeadline(1000, () => {});
  let calls = 0;
  try {
    assert.equal(await deadline.wait(Promise.resolve("work"), 100, () => { calls++; return "fallback"; }), "work");
    await assert.rejects(deadline.wait(Promise.reject(Error("work failed")), 100, () => { calls++; return "fallback"; }), /work failed/);
    assert.equal(calls, 0);
    assert.equal(await deadline.wait(new Promise<string>(() => {}), 1, () => { calls++; return "fallback"; }), "fallback");
    assert.equal(calls, 1);
  } finally { deadline.close(); }
});
