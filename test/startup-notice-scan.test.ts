import { test } from "node:test";
import assert from "node:assert/strict";
import { startupNoticeTarget } from "../src/startup-notice.js";

test("stop after the second distinct eligible room", () => {
  let reads = 0;
  const sessions = Array.from({ length: 1000 }, (_, i) => ({
    key: `matrix:room${i % 2}`,
    get replyTo() { reads++; return { channel: "matrix", target: `room${i % 2}` }; },
  }));
  assert.equal(startupNoticeTarget(undefined, sessions, new Set(["matrix"])), undefined);
  assert.equal(reads, 2);
});

test("duplicates, historical threads and ineligible entries do not create ambiguity", () => {
  const room = { channel: "matrix", target: "room" };
  const sessions = [
    { key: "api:old", replyTo: { channel: "api", target: "old" } },
    { key: "other:mismatch", replyTo: { channel: "matrix", target: "other" } },
    { key: "matrix:room", replyTo: { ...room, thread: "one" } },
    { key: "matrix:room:thread", replyTo: { ...room, thread: "two" } },
    { key: "missing:room", replyTo: { channel: "missing", target: "other" } },
  ];
  assert.deepEqual(startupNoticeTarget(undefined, sessions, new Set(["matrix", "api"])), room);
  assert.equal(startupNoticeTarget(undefined, [], new Set(["matrix"])), undefined);
  assert.deepEqual(startupNoticeTarget(room, [], new Set(["matrix"])), room);
  assert.equal(startupNoticeTarget(room, [], new Set()), undefined);
});
