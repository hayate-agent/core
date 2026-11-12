import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayProgress, progressMode } from "../src/channels/progress.js";

test("progress configuration validates modes and defaults off", () => {
  assert.equal(progressMode(), "off");
  assert.throws(() => progressMode("everything"));
});
test("off emits nothing; reduced summarizes tools without outputs", async () => {
  for (const mode of ["off", "reduced"] as const) {
    const sent: string[] = [];
    const p = new GatewayProgress(mode, async (text) => { sent.push(text); });
    p.event({type:"text",delta:"Final response"});
    p.event({type:"tool",phase:"start",name:"bash",detail:"private args"});
    p.event({type:"tool",phase:"end",name:"bash",detail:"private result"});
    p.event({type:"tool",phase:"start",name:"bash"});
    await p.finish();
    assert.deepEqual(sent, mode === "off" ? [] : ["⏳ bash gestartet\n\n✓ bash beendet\n\n⏳ bash gestartet"]);
  }
});
test("full progress never reads MCP arguments or results, but retains status", async () => {
  const sent: string[] = [];
  const p = new GatewayProgress("full", async text => { sent.push(text); });
  for (const name of ["mcp__fritz_brain__brain_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
    for (const phase of ["start", "end"] as const) {
      p.event({ type: "tool", phase, name, error: phase === "end",
        get detail(): string { throw new Error("MCP payload must not be inspected"); } });
    }
  }
  p.event({ type: "tool", phase: "end", name: "bash", detail: "ordinary output" });
  await p.finish();
  assert.match(sent.join("\n"), /⏳ mcp__fritz_brain__brain_search/);
  assert.match(sent.join("\n"), /⚠ mcp__fritz_brain__brain_search/);
  assert.match(sent.join("\n"), /ordinary output/);
});

test("heartbeats share the per-turn progress budget", async () => {
  const sent: string[] = [];
  const progress = new GatewayProgress("reduced", async (text) => { sent.push(text); }, 2);
  for (let i = 0; i < 49; i++) progress.event({ type: "tool", name: "review", phase: "start" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await progress.finish();
  assert.equal(sent.join("\n").split("läuft weiterhin").length - 1, 1);
});

test("long reviews emit truthful heartbeats and stop after completion", async () => {
  const sent: string[] = [];
  const p = new GatewayProgress("reduced", async (text) => { sent.push(text); }, 10);
  p.event({ type: "tool", phase: "start", name: "plugin_review", detail: "private" });
  await new Promise((r) => setTimeout(r, 35));
  assert.ok(sent.some((s) => s.includes("plugin_review läuft weiterhin")));
  assert.ok(sent.every((s) => !s.includes("private")));
  p.event({ type: "tool", phase: "end", name: "plugin_review" });
  await p.finish();
  const count = sent.length;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(sent.length, count);
});

test("blocked delivery coalesces heartbeat backlog and retains the final batch", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const sent: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const p = new GatewayProgress("reduced", async (text) => {
    sent.push(text);
    if (sent.length === 1) await blocked;
  }, 10);
  p.event({ type: "tool", phase: "start", name: "bash" });
  // Stay within the shared event budget; exhaustion is covered separately.
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(10);
    await Promise.resolve();
  }
  assert.equal(sent.length, 1);
  p.event({ type: "tool", phase: "end", name: "bash" });
  let finished = false;
  const finishing = p.finish().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await finishing;
  assert.equal(sent.length, 2, "retain only in-flight and latest pending batch");
  assert.match(sent[1], /✓ bash beendet/);
});

test("a failed blocked send still drains the latest batch", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const sent: string[] = [];
  let reject!: (error: Error) => void;
  const blocked = new Promise<void>((_resolve, fail) => { reject = fail; });
  const p = new GatewayProgress("reduced", async (text) => {
    sent.push(text);
    if (sent.length === 1) await blocked;
  }, 10);
  p.event({ type: "tool", phase: "start", name: "bash" });
  t.mock.timers.tick(10);
  p.event({ type: "tool", phase: "end", name: "bash" });
  const finishing = p.finish();
  reject(new Error("offline"));
  await finishing;
  assert.equal(sent.length, 2);
  assert.match(sent[1], /✓ bash beendet/);
  p.event({ type: "tool", phase: "start", name: "ignored" });
  t.mock.timers.tick(2000);
  await p.finish();
  assert.equal(sent.length, 2);
});

test("full bounds output and events; telemetry failures do not reject finish", async () => {
  const sent: string[] = [];
  const p = new GatewayProgress("full", async (text) => { sent.push(text); throw new Error("network"); });
  for (let i=0;i<100;i++) p.event({type:"tool",phase:"end",name:"bash",error:true,detail:"x".repeat(3000)});
  await p.finish();
  assert.equal(sent.length,1);
  assert.ok(sent[0].includes("⚠ bash"));
  assert.ok(sent[0].length <= 8000);
});

 test("parallel same-name tools emit one start and one final completion", async () => {
 const sent: string[] = []; const p = new GatewayProgress("reduced", async text => { sent.push(text); });
 for(let i=0;i<5;i++) p.event({type:"tool",phase:"start",name:"read"});
 for(let i=0;i<4;i++) p.event({type:"tool",phase:"end",name:"read",error:i===0});
 p.event({type:"tool",phase:"end",name:"read"}); await p.finish();
 const text=sent.join("\n"); assert.equal((text.match(/read gestartet/g)||[]).length,1);
 assert.equal((text.match(/read beendet/g)||[]).length,1); assert.match(text,/⚠ read beendet/);
 });
