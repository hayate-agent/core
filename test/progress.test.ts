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
    assert.deepEqual(sent, mode === "off" ? [] : ["Working: bash"]);
  }
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
