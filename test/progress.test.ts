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
    assert.deepEqual(sent, mode === "off" ? [] : ["▶ bash gestartet\n\n✓ bash beendet\n\n▶ bash gestartet"]);
  }
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

test("full bounds output and events; telemetry failures do not reject finish", async () => {
  const sent: string[] = [];
  const p = new GatewayProgress("full", async (text) => { sent.push(text); throw new Error("network"); });
  for (let i=0;i<100;i++) p.event({type:"tool",phase:"end",name:"bash",error:true,detail:"x".repeat(3000)});
  await p.finish();
  assert.equal(sent.length,1);
  assert.ok(sent[0].includes("⚠ bash"));
  assert.ok(sent[0].length <= 8000);
});
