import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSessions } from "../src/local-sessions.js";
import { test } from "node:test";
import { HarnessTuiChannel } from "../src/channels/tui.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";

function terminal() {
  let input: (data: string) => void = () => {};
  let output = "";
  const noop = () => {};
  const t = {
    columns: 100, rows: 30, kittyProtocolActive: false,
    start: (cb: (data: string) => void) => { input = cb; }, stop: noop,
    drainInput: async () => {}, write: (text: string) => { output += text; },
    moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop,
    clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, setProgramStatus: noop,
  } satisfies Terminal;
  return { t, type: (s: string) => { for (const ch of s) input(ch); }, send: (s: string) => input(s), output: () => output };
}

test("TUI shows observed selection rather than configured defaults and resets next turn", async () => {
  const term = terminal(); term.t.columns = 220;
  const channel = new HarnessTuiChannel({ agent: "test", status: () => "running", model: () => "configured/default", quit: () => {}, terminal: term.t });
  await channel.start(async () => {});
  try {
    await channel.typing({ channel: "tui", target: "main" }, true);
    assert.match((channel as any).activityLabel(), /preparing model selection/);
    channel.turnEvent({ channel: "tui", target: "main" }, { type: "execution", selection: { model: "actual/worker", thinking: "off" } });
    assert.match((channel as any).activityLabel(), /model actual\/worker · reasoning off/);
    await channel.typing({ channel: "tui", target: "main" }, true);
    assert.match((channel as any).activityLabel(), /preparing model selection/);
    assert.doesNotMatch((channel as any).activityLabel(), /actual\/worker/);
  } finally { await channel.stop(); }
});

test("plugin UI supports input, selection, custom keyboard widgets and abort", async () => {
  const term = terminal();
  const channel = new HarnessTuiChannel({ agent: "test", status: () => "running", quit: () => {}, terminal: term.t });
  await assert.rejects(channel.pluginUI().prompt("offline"), /not running/);
  await channel.start(async () => {});
  const ui = channel.pluginUI();
  try {
    const input = ui.prompt("Enter value");
    term.type("hello\r");
    assert.equal(await input, "hello");
    const choice = ui.select("Choose", [{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    term.type("\r");
    assert.equal(await choice, "a");
    const confirmation = ui.confirm("Confirm");
    term.type("\r");
    assert.equal(await confirmation, false);
    const custom = ui.custom("Custom form", { render: () => ["Press x"], handleInput: (key) => key === "x" ? { value: "selected" } : undefined });
    term.type("x");
    assert.equal(await custom, "selected");
    const cancelled = ui.custom("Cancel", { render: () => ["Escape cancels"], handleInput: () => {} });
    term.type("\u001b");
    await assert.rejects(cancelled, /cancelled/);
    const pending = ui.prompt("Pending");
    await channel.stop();
    await assert.rejects(pending, /cancelled/);
  } finally { await channel.stop(); }
});

test("plugin panels are bounded plain text and rendering failures do not break editor", async () => {
  const term = terminal();
  const ui = new HarnessTuiChannel({ agent: "test", status: () => "running", quit: () => {}, terminal: term.t,
    panels: () => [
      { name: "broken", render: () => { throw Error("private failure"); } },
      { name: "status", render: () => ["Plugin status: ready\u001b[2J", "x".repeat(1000), "third", "overflow"] },
    ],
  });
  try {
    await ui.start(async () => {});
    await new Promise((r) => setTimeout(r, 30));
    const screen = (ui as any).tui.getScreenLines().join("\n");
    assert.match(screen, /panel unavailable/);
    assert.match(screen, /Plugin status: ready/);
    assert.ok(!screen.includes("private failure"));
    assert.ok(!screen.includes("overflow"));
    assert.ok(!screen.includes("\u001b[2J"));
    assert.match(screen, /\/help/);
  } finally { await ui.stop(); }
});

test("fullscreen layout keeps the editor at the bottom after long output", async () => {
  const term = terminal();
  const ui = new HarnessTuiChannel({ agent: "test", status: () => "running", quit: () => {}, terminal: term.t });
  try {
    await ui.start(async () => {});
    await ui.send({ channel: "console", target: "local" }, Array.from({ length: 150 }, (_, i) => `Output line ${i}`).join("\n"));
    await new Promise((r) => setTimeout(r, 30));
    // Inspect the rendered viewport, not merely presence of terminal escape sequences.
    const screen = (ui as unknown as { tui: { getScreenLines(): string[] } }).tui.getScreenLines();
    assert.equal(screen.length, term.t.rows);
    assert.match(screen.slice(0, 3).join("\n"), /Hayate Agent/);
    assert.match(screen.slice(-8).join("\n"), /\/help/);
    assert.ok(!screen.some((line) => /Output line 0$/.test(line)));
  } finally { await ui.stop(); }
});

test("footer resolves the actual session model and reasoning before the first prompt", async () => {
  const term = terminal();
  let ready = false;
  let reasoning = "high";
  const ui = new HarnessTuiChannel({
    agent: "test", status: () => "running", terminal: term.t, quit: () => {},
    prepareSession: async () => { ready = true; },
    model: () => ready ? "provider/actual-model" : "unavailable",
    reasoning: () => reasoning,
  });
  try {
    await ui.start(async () => {});
    await new Promise((r) => setTimeout(r, 30));
    const footer = () => (ui as any).tui.getScreenLines().at(-1);
    assert.match(footer(), /Model: provider\/actual-model · Reasoning: high/);
    reasoning = "off";
    ui.note("Settings changed");
    await new Promise((r) => setTimeout(r, 30));
    assert.match(footer(), /Reasoning: off/);
  } finally { await ui.stop(); }
});

test("model footer stays below the editor and dialogs across output, resize and model changes", async () => {
  const term = terminal();
  let model = "provider/initial";
  const ui = new HarnessTuiChannel({ agent: "test", status: () => "running", model: () => model, quit: () => {}, terminal: term.t });
  const screen = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return (ui as unknown as { tui: { getScreenLines(): string[] } }).tui.getScreenLines();
  };
  try {
    await ui.start(async () => {});
    term.type("editor marker");
    await ui.send({ channel: "console", target: "local" }, "Long output\n".repeat(150));
    let lines = await screen();
    assert.match(lines.at(-1)!, /Model: provider\/initial/);
    assert.ok(lines.findIndex((line) => line.includes("editor marker")) < lines.length - 1);
    assert.ok(lines.some((line) => line.includes("editor marker")));
    assert.ok(!lines.slice(0, 4).join("\n").includes("Model:"));
    for (const [columns, rows] of [[45, 16], [120, 40]]) {
      term.t.columns = columns!;
      term.t.rows = rows!;
      model = "provider/changed-" + "x".repeat(150);
      ui.note("Resize render");
      lines = await screen();
      assert.equal(lines.length, rows);
      assert.match(lines.at(-1)!, /Model: provider\/changed/);
    }
    const pending = ui.pluginUI().prompt("Dialog marker");
    lines = await screen();
    assert.match(lines.at(-1)!, /Model: provider\/changed/);
    assert.match(lines.slice(0, -1).join("\n"), /Dialog marker/);
    term.type("answer\r");
    assert.equal(await pending, "answer");
    lines = await screen();
    assert.match(lines.at(-1)!, /Model: provider\/changed/);
    assert.match(lines.slice(0, -1).join("\n"), /editor marker/);
  } finally { await ui.stop(); }
});

test("TUI login masks secrets and does not submit credentials to the Harness", async () => {
  const term = terminal();
  let credential = "";
  let submitted = false;
  const ui = new HarnessTuiChannel({
    agent: "test", status: () => "running", quit: () => {}, terminal: term.t,
    login: async (dialog) => { credential = await dialog.prompt("API key", true); },
  });
  try {
    await ui.start(async () => { submitted = true; });
    term.type("/login\r");
    await new Promise((r) => setTimeout(r, 20));
    term.type("test-private-key");
    await new Promise((r) => setTimeout(r, 20));
    term.type("\r");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(credential, "test-private-key");
    assert.equal(submitted, false);
    assert.ok(!term.output().includes("test-private-key"));
  } finally { await ui.stop(); }
});

test("TUI submits into the actual Harness and displays its delivered answer", async () => {
  const term = terminal();
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", log: () => {} });
  let quit = false;
  const ui = new HarnessTuiChannel({ agent: "test-agent", status: () => "Queue: 0", quit: () => { quit = true; }, terminal: term.t });
  harness.addChannel(ui);
  try {
    await harness.start();
    term.type("hello\r");
    await new Promise((r) => setTimeout(r, 30));
    await harness.drained();
    assert.deepEqual(runtime.sessions.get("console:local")!.prompts, ["hello"]);
    term.type("/quit\r");
    assert.equal(quit, true);
    assert.match(term.output(), /Hayate Agent/);
  } finally { await harness.stop(); }
});

test("transcript follows output at the end, preserves reading position, and supports clickable/keyboard jump", async () => {
  const term = terminal();
  const ui = new HarnessTuiChannel({ agent: "test", color: false, status: () => "", quit: () => {}, terminal: term.t });
  const address = { channel: "console", target: "local" };
  const tui = (ui as any).tui;
  const scroll = (ui as any).conversationScroll;
  const screen = async () => { await new Promise((r) => setTimeout(r, 40)); return tui.getScreenLines().map(stripTerminalSequences) as string[]; };
  try {
    await ui.start(async () => {});
    await ui.send(address, "```text\n" + Array.from({ length: 120 }, (_, i) => `history-${i}`).join("\n") + "\n```");
    assert.match((await screen()).join("\n"), /history-119/);
    assert.equal(scroll.isFollowingEnd, true);
    tui.scrollBy(-15);
    await screen();
    assert.equal(scroll.isFollowingEnd, false);
    const top = scroll.scrollTop;
    await ui.send(address, "New output while reading history");
    let lines = await screen();
    assert.equal(scroll.scrollTop, top);
    assert.ok(!lines.join("\n").includes("New output while reading history"));
    const y = lines.findIndex((line) => line.includes("Jump to latest"));
    assert.ok(y >= 0, "jump indicator is visible while reading older content");
    const x = lines[y]!.indexOf("Jump to latest");
    term.send(`\x1b[<0;${x + 1};${y + 1}M`);
    term.send(`\x1b[<0;${x + 1};${y + 1}m`);
    lines = await screen();
    assert.equal(scroll.isFollowingEnd, true);
    assert.match(lines.join("\n"), /New output while reading history/);
    assert.ok(!lines.join("\n").includes("Jump to latest"));
    tui.scrollBy(-10); await screen();
    term.send("\x1b[1;5F");
    await screen();
    assert.equal(scroll.isFollowingEnd, true, "Ctrl+End resumes following");
    await ui.send(address, "Latest tail");
    assert.match((await screen()).join("\n"), /Latest tail/);
  } finally { await ui.stop(); }
});

test("working indicator is visible while the SDK session is still opening", async () => {
  const term = terminal();
  const runtime = new FakeRuntime();
  const open = runtime.open.bind(runtime);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  runtime.open = async (key, options) => { await gate; return open(key, options); };
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", log: () => {} });
  const ui = new HarnessTuiChannel({ agent: "test", status: () => "running", quit: () => {}, terminal: term.t });
  harness.addChannel(ui);
  try {
    await harness.start();
    term.type("hello\r");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(runtime.opened.length, 0);
    assert.match((ui as any).tui.getScreenLines().join("\n"), /Working/);
    release();
    await harness.drained();
    await new Promise((r) => setTimeout(r, 30));
    assert.match((ui as any).tui.getScreenLines().join("\n"), /Done/);
  } finally { release(); await harness.stop(); }
});

test("activity stays out of chat, streams visibly, handles parallel tools and marks failures", async () => {
  const term = terminal();
  let queued = 0;
  const ui = new HarnessTuiChannel({ agent: "agent", color: false, status: () => "running", quit: () => {}, terminal: term.t,
    workState: () => ({ running: false, queued }) });
  const address = { channel: "console", target: "local" };
  const screen = async () => { await new Promise((r) => setTimeout(r, 30)); return (ui as any).tui.getScreenLines().join("\n"); };
  try {
    await ui.start(async () => {});
    await ui.typing(address, true);
    assert.match(await screen(), /Working/);
    queued = 2;
    ui.turnEvent(address, { type: "tool", phase: "start", name: "bash" });
    ui.turnEvent(address, { type: "tool", phase: "start", name: "bash" });
    assert.match(await screen(), /bash ×2/);
    assert.match(await screen(), /2 queued/);
    ui.turnEvent(address, { type: "tool", phase: "end", name: "bash" });
    assert.match(await screen(), /Running: bash/);
    ui.turnEvent(address, { type: "tool", phase: "end", name: "bash", error: true });
    assert.match(await screen(), /1 failed/);
    ui.turnEvent(address, { type: "text", delta: "Live answer before completion" });
    assert.match(await screen(), /Live answer before completion/);
    assert.match(await screen(), /Writing response/);
    await ui.typing(address, false);
    queued = 0;
    await ui.send(address, "Provider unavailable", { outcome: "failed" });
    const finished = await screen();
    assert.match(finished, /✕ Provider unavailable/);
    assert.match(finished, /✕ Failed/);
    assert.ok(!finished.includes("Tool bash: start"));
    assert.ok(!(ui as any).lines.some((entry: { text: string }) => entry.text.includes("Tool")));
    assert.ok(!finished.includes("agent:"));
    await ui.typing(address, true);
    assert.ok(!(await screen()).includes("tools completed"), "next turn resets activity counters");
  } finally { await ui.stop(); }
});

test("local TUI isolates sessions, blocks busy switches, restores visible history and filters foreign replies", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-local-ui-"));
  const sessions = await LocalSessions.open(home, home);
  const first = await sessions.create("Original");
  const dir = path.join(home, "sessions", first.key);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "2026.jsonl"), JSON.stringify({ id: "m", parentId: null, message: { role: "user", content: "visible previous history" } }));
  const term = terminal();
  const inputs: Array<{ sessionKey: string; replyTo?: { target: string } }> = [];
  let idle = true;
  const ui = new HarnessTuiChannel({ agent: "test", status: () => "running", quit: () => {}, terminal: term.t, sessions, canSwitchSession: () => idle });
  const settle = () => new Promise((r) => setTimeout(r, 40));
  try {
    await ui.start(async (input) => { inputs.push(input); });
    term.type("one\r");
    assert.equal(inputs[0]!.sessionKey, first.key);
    assert.equal(inputs[0]!.replyTo!.target, first.key);
    idle = false;
    term.type("/new blocked\r"); await settle();
    assert.equal(sessions.current?.id, first.id);
    idle = true;
    term.type("/new Second\r");
    const deadline = Date.now() + 5000;
    while (sessions.current?.id === first.id && Date.now() < deadline) await settle();
    const second = sessions.current!;
    assert.notEqual(second.id, first.id);
    term.type("two\r");
    assert.equal(inputs[1]!.sessionKey, second.key);
    await ui.send({ channel: "console", target: first.key }, "foreign secret answer");
    await settle();
    assert.ok(!(ui as any).tui.getScreenLines().join("\n").includes("foreign secret answer"));
    term.type(`/resume ${first.id}\r`);
    const resumeDeadline = Date.now() + 5000;
    while (sessions.current?.id !== first.id && Date.now() < resumeDeadline) await settle();
    await settle();
    assert.equal(sessions.current?.id, first.id);
    assert.match((ui as any).tui.getScreenLines().join("\n"), /visible previous history/);
    term.type("/title Renamed\r");
    const titleDeadline = Date.now() + 5000;
    while (sessions.current?.title !== "Renamed" && Date.now() < titleDeadline) await settle();
    assert.equal(sessions.current?.title, "Renamed");
    term.type("three\r");
    assert.equal(inputs[2]!.sessionKey, first.key);
    assert.equal(inputs.length, 3, "session UI commands never become model prompts");
  } finally { await ui.stop(); await rm(home, { recursive: true, force: true }); }
});


test("routine status replaces the footer without adding conversation messages", async () => {
  const term = terminal();
  const ui = new HarnessTuiChannel({ agent: "test", status: () => "running", quit: () => {}, terminal: term.t });
  const to = { channel: "console", target: "local" };
  try {
    await ui.start(async () => {});
    await ui.send(to, "worker started", { presentation: "progress", progressId: "worker" });
    await ui.send(to, "worker recovering", { presentation: "progress", progressId: "worker" });
    assert.equal((ui as any).lines.length, 0);
    await new Promise(r => setTimeout(r, 30));
    assert.match((ui as any).tui.getScreenLines().join("\n"), /worker recovering/);
    await ui.send(to, "actual result");
    assert.equal((ui as any).lines.length, 1);
    assert.equal((ui as any).routineStatus, "");
  } finally { await ui.stop(); }
});
