import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, type CommandContext } from "../src/commands.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

async function run(kind: "heartbeat" | "loop", args: string) {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, log: () => {} });
  harness.onStateChange = async () => {};
  const reply = await COMMANDS.find(c => c.name === kind)!.run(args, { sessionKey: "k", source: "channel", text: "" } as any, { harness } as CommandContext);
  const s = harness.state("k");
  await harness.stop(0);
  return { reply: String(reply), hb: s.heartbeat, loop: s.loop };
}

test("heartbeat keeps multi-line prompt and indentation", async () => {
  const r = await run("heartbeat", "every 5m line1\nline2\n\n  indented  ");
  assert.equal(r.hb!.prompt, "line1\nline2\n\n  indented");
  assert.equal(r.hb!.everyMs, 300000);
});
test("newline directly after interval and tab separators", async () => {
  assert.equal((await run("heartbeat", "every 5m\ncheck\nthis")).hb!.prompt, "check\nthis");
  assert.equal((await run("heartbeat", "every\t5m\tdo it")).hb!.prompt, "do it");
});
test("single-line behaviour and defaults unchanged", async () => {
  const a = await run("heartbeat", "every 1h30m  ping   me");
  assert.equal(a.hb!.everyMs, 5400000);
  assert.equal(a.hb!.prompt, "ping   me");
  assert.equal((await run("heartbeat", "check things")).hb!.everyMs, 1800000);
  assert.equal((await run("heartbeat", "check things")).hb!.prompt, "check things");
});
test("errors unchanged", async () => {
  assert.match((await run("heartbeat", "every 9999999999999999999d x")).reply, /invalid interval/);
  assert.match((await run("heartbeat", "every 10s x")).reply, /minimum interval is 1m/);
  assert.match((await run("heartbeat", "every 5m   ")).reply, /usage/);
  assert.match((await run("heartbeat", "every")).reply, /invalid interval/);
  assert.match((await run("loop", "5m x --times 0")).reply, /--times needs/);
  assert.match((await run("loop", "5m x --times")).reply, /--times needs/);
});
test("loop: --times parsed anywhere, multi-line prompt kept", async () => {
  const a = await run("loop", "5m step1\nstep2 --times 3");
  assert.equal(a.loop!.prompt, "step1\nstep2"); assert.equal(a.loop!.remaining, 3);
  const b = await run("loop", "--times 2 5m\nstep");
  assert.ok(b.loop || /invalid|usage/.test(b.reply), b.reply);
  const c = await run("loop", "write --timesheet report");
  assert.equal(c.loop!.prompt, "write --timesheet report");
});
