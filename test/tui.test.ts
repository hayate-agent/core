import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessTuiChannel } from "../src/channels/tui.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import type { Terminal } from "@earendil-works/pi-tui";

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
  return { t, type: (s: string) => { for (const ch of s) input(ch); }, output: () => output };
}

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
    assert.match(screen.slice(0, 3).join("\n"), /VanillaCore Agent Harness/);
    assert.match(screen.slice(-8).join("\n"), /\/help/);
    assert.ok(!screen.some((line) => /Output line 0$/.test(line)));
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
    assert.match(term.output(), /VanillaCore Agent Harness/);
  } finally { await harness.stop(); }
});
