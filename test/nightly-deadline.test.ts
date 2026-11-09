import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { improvementDeadline } from "../src/improvement.js";
import { improvementPolicy, ImprovementController } from "./improvement-default.js";
import { assessCompletion } from "./completion-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

test("host nightly deadline respects local timezone and DST transitions", () => {
  const p = improvementPolicy({ timezone: "Europe/Berlin" });
  for (const [start, end] of [
    ["2026-03-28T22:30:00Z", "2026-03-29T03:00:00Z"],
    ["2026-10-24T21:30:00Z", "2026-10-25T04:00:00Z"],
    ["2026-11-09T22:30:00Z", "2026-11-10T04:00:00Z"],
  ]) assert.equal(improvementDeadline(Date.parse(start!), p), Date.parse(end!));
  const expired = Date.parse("2026-11-10T04:00:00Z");
  assert.equal(improvementDeadline(expired, p), expired);
});

test("controller host deadline reaches the completion assessor and fences expiry during review", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-deadline-"));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 6\ntimezone: UTC\n");
  let now = Date.parse("2026-10-25T04:59:00Z");
  const deadline = Date.parse("2026-10-25T05:00:00Z");
  const receipt = "```improvement-experiment\n" + JSON.stringify({ execution: "performed", hypothesis: "deadline",
    baseline: "measured", candidate: "tried", evidence: "test output", outcome: "rejected" }) + "\n```\n[IMPROVEMENT_DONE]";
  const h = new Harness({ runtime: new FakeRuntime(() => receipt), tickMs: 60000 });
  let backendCalls = 0;
  const c = new ImprovementController(home, h, "UTC", () => now, async request => {
    assert.equal(request.expiresAt, deadline);
    const verdict = await assessCompletion({ review: async (prompt, _model, _thinking, signal) => {
      backendCalls++;
      assert.ok(!signal.aborted);
      assert.ok(prompt.includes(String(deadline)), "the reviewer sees the host deadline");
      now = deadline;
      return '{"state":"completed"}';
    } }, request.input, request.reply, { task: "Review the whole authorized night", purpose: "nightly-closure", expiresAt: request.expiresAt },
    request.signal, undefined, () => now);
    assert.equal(verdict, undefined, "the assessor rejects even a syntactically valid late verdict");
    return verdict;
  });
  const opts = (h as any).opts;
  opts.beforeTurn = (input: any) => c.before(input);
  opts.afterTurn = async (input: any, reply: string, _session: unknown, _options: unknown, signal: AbortSignal) => {
    await c.completed(input, reply, signal); return reply;
  };
  try {
    await c.tick(); await h.drained();
    assert.equal(backendCalls, 1);
  } finally { await h.stop(1000); await rm(home, { recursive: true, force: true }); }
});
