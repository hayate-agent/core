import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessTuiChannel } from "../src/channels/tui.js";
import { TurnActivity, type ActivitySnapshot } from "../src/activity.js";
import type { LocalSessions } from "../src/local-sessions.js";
import type { Terminal } from "@earendil-works/pi-tui";

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

test("legacy retry can explicitly start again but cannot downgrade a sequenced owner", () => {
  const ui = make(), to = { channel: "console", target: "local" };
  const legacy = (id: string, phase: ActivitySnapshot["phase"]) => ({ ...snapshot(id, 0, "main", phase), sequence: undefined });
  ui.taskActivity(to, event(legacy("same", "running")));
  ui.taskActivity(to, event(legacy("same", "completed")));
  ui.taskActivity(to, event(legacy("same", "running")));
  assert.equal(rows(ui).length, 0);
  ui.taskActivity(to, event(legacy("same", "starting")));
  assert.equal(rows(ui).length, 1);
  ui.taskActivity(to, event(snapshot("current", 10)));
  for (const old of [legacy("current", "completed"), legacy("other", "starting")]) ui.taskActivity(to, event(old));
  ui.taskActivity(to, event(snapshot("stale", 9)));
  assert.equal(rows(ui).length, 1);
  assert.match(rows(ui)[0]!.label, /model current/);
  assert.equal((ui as any).execution.model, "current");
});

test("bounded worker history cannot evict the current main owner", () => {
  const ui = make(), to = { channel: "console", target: "local" };
  ui.taskActivity(to, event(snapshot("main", 1)));
  for (let i = 0; i < 30; i++) ui.taskActivity(to, event(snapshot(`worker-${i}`, i + 2, "worker")));
  assert.equal(rows(ui).length, 16);
  assert.equal(rows(ui).filter(row => row.label.startsWith("Main")).length, 1);
});

test("rendered screen has one main while one input is queued, including late old events", async () => {
  const noop = () => {};
  const terminal = { columns: 220, rows: 30, kittyProtocolActive: false,
    start: noop, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop,
    hideCursor: noop, showCursor: noop, clearLine: noop, clearFromCursor: noop,
    clearScreen: noop, setTitle: noop, setProgress: noop, setProgramStatus: noop,
  } satisfies Terminal;
  const ui = new HarnessTuiChannel({ agent: "test", color: false, status: () => "", quit: noop, terminal,
    workState: () => ({ running: true, queued: 1 }) });
  const to = { channel: "console", target: "local" };
  await ui.start(async () => {});
  try {
    await ui.typing(to, true);
    ui.taskActivity(to, event(snapshot("old", 1)));
    ui.taskActivity(to, event(snapshot("new", 2)));
    ui.taskActivity(to, event(snapshot("old", 1, "main", "tool")));
    // Wait for the requested rendered state, not an assumed 40ms frame budget:
    // constrained CI can schedule the TUI's first frame later under full-suite load.
    let screen = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      screen = (ui as any).tui.getScreenLines().join("\n");
      if ((screen.match(/Main · task/g) ?? []).length === 1 && /model new/.test(screen) && /1 queued/.test(screen)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((screen.match(/Main · task/g) ?? []).length, 1);
    assert.match(screen, /1 queued/);
    assert.match(screen, /model new/);
    assert.doesNotMatch(screen, /model old/);
  } finally { await ui.stop(); }
});

test("host generations increase across retries without changing durable activity identity", () => {
  const first = new TurnActivity({ id: "same", role: "main", context: "operator" }, () => {}, { enabled: false });
  const second = new TurnActivity({ id: "same", role: "main", context: "operator" }, () => {}, { enabled: false });
  assert.equal(first.snapshot().id, second.snapshot().id);
  assert.ok(second.snapshot().sequence! > first.snapshot().sequence!);
});
