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
