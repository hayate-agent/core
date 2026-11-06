import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessTuiChannel } from "../src/channels/tui.js";
import { TurnActivity, type ActivitySnapshot } from "../src/activity.js";
import type { LocalSessions } from "../src/local-sessions.js";

const snapshot = (id: string, sequence: number, role: ActivitySnapshot["role"] = "main", phase: ActivitySnapshot["phase"] = "running"): ActivitySnapshot => ({
  id, sequence, role, phase, context: "operator", activity: "runtime active", tools: [], elapsedMs: 0, inactiveMs: 0,
  execution: { model: id, thinking: "off" }, executionState: "observed",
});
const event = (s: ActivitySnapshot) => ({ type: "activity" as const, kind: "progress" as const, snapshot: s });
const make = (sessions?: LocalSessions) => new HarnessTuiChannel({ agent: "test", status: () => "", quit() {}, sessions });
const rows = (ui: HarnessTuiChannel): Array<{ target: string; label: string }> => [...(ui as any).classifiers.values()];

test("one main row per session; late progress/finish cannot resurrect or replace the current owner", () => {
  const ui = make(), to = { channel: "console", target: "local" };
  ui.taskActivity(to, event(snapshot("old", 1)));
  ui.taskActivity(to, event(snapshot("new", 2)));
  assert.equal(rows(ui).length, 1);
  assert.match(rows(ui)[0]!.label, /model new/);
  for (const phase of ["starting", "running", "tool", "completed", "failed", "cancelled"] as const) {
    ui.taskActivity(to, event(snapshot("old", 1, "main", phase)));
    assert.equal(rows(ui).length, 1);
    assert.match(rows(ui)[0]!.label, /model new/);
    assert.equal((ui as any).execution.model, "new");
  }
  ui.taskActivity(to, event(snapshot("new", 2, "main", "completed")));
  assert.equal(rows(ui).length, 0);
  ui.taskActivity(to, event(snapshot("new", 2)));
  assert.equal(rows(ui).length, 0, "settled generation cannot reappear");
});

test("worker and classifier remain independent; same durable ID can retry with a newer generation", () => {
  const ui = make(), to = { channel: "console", target: "local" };
  ui.taskActivity(to, event(snapshot("worker", 1, "worker")));
  ui.taskActivity(to, event(snapshot("classifier", 2, "dispatcher-classifier")));
  ui.taskActivity(to, event(snapshot("main", 3)));
  ui.taskActivity(to, event(snapshot("main", 3, "main", "cancelled")));
  assert.equal(rows(ui).length, 2);
  ui.taskActivity(to, event(snapshot("main", 4)));
  ui.taskActivity(to, event(snapshot("main", 3, "main", "failed")));
  assert.equal(rows(ui).length, 3);
  assert.equal(rows(ui).filter(row => row.label.startsWith("Main")).length, 1);
  ui.taskActivity(to, event(snapshot("worker", 1, "worker", "completed")));
  assert.equal(rows(ui).length, 3, "worker terminal evidence remains independently addressable");
  assert.match(rows(ui).find(row => row.label.startsWith("Worker"))!.label, /completed/);
});

test("session ownership is independent and foreign session events cannot alter current execution", () => {
  const sessions = { current: { key: "A" } } as unknown as LocalSessions;
  const ui = make(sessions);
  ui.taskActivity({ channel: "console", target: "A" }, event(snapshot("A-main", 1)));
  ui.taskActivity({ channel: "console", target: "B" }, event(snapshot("B-foreign", 9)));
  assert.equal((ui as any).execution.model, "A-main");
  (sessions as any).current = { key: "B" };
  ui.taskActivity({ channel: "console", target: "B" }, event(snapshot("B-main", 2)));
  (sessions as any).current = { key: "A" };
  ui.taskActivity({ channel: "console", target: "A" }, event(snapshot("A-new", 3)));
  assert.equal(rows(ui).filter(row => row.target === "A").length, 1);
  assert.equal(rows(ui).filter(row => row.target === "B").length, 1);
  assert.equal((ui as any).execution.model, "A-new");
});

test("host generations increase across retries without changing durable activity identity", () => {
  const first = new TurnActivity({ id: "same", role: "main", context: "operator" }, () => {}, { enabled: false });
  const second = new TurnActivity({ id: "same", role: "main", context: "operator" }, () => {}, { enabled: false });
  assert.equal(first.snapshot().id, second.snapshot().id);
  assert.ok(second.snapshot().sequence! > first.snapshot().sequence!);
});
