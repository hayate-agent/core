import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { FakeRuntime } from "./fakes.js";

test("manual handover rotates idle session immediately without a working prompt, even with automation disabled", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "manual-handover-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const open = runtime.open.bind(runtime);
  let summaries = 0; let seeded = "";
  runtime.open = async (key, options) => {
    const session = await open(key, options);
    Object.assign(session, { archiveEntries: () => [], summarize: async () => { summaries++; return "verified checkpoint"; },
      seedHandover: async (text: string) => { seeded = text; } });
    return session;
  };
  const maintenance = new ContextMaintenance(home, () => contextPolicy({ enabled: false, autoHandover: false }));
  const harness = new Harness({ runtime, contextMaintenance: maintenance, tickMs: 60000, busyMode: "queue" });
  harness.onStateChange = async () => {};
  const result = await harness.handover("chat", "Continue testing only");
  assert.match(result, /Neue Sitzung/);
  assert.equal(summaries, 1);
  assert.match(seeded, /verified checkpoint/);
  assert.match(seeded, /Continue testing only/);
  assert.equal(runtime.opened.filter(entry => entry.fresh).length, 1);
  assert.equal(runtime.sessions.get("chat")!.prompts.length, 0);
});

test("manual handover refuses a busy conversation without recording a request", async () => {
  let requests = 0;
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, busyMode: "queue", contextMaintenance: {
    guidance: async () => "", request: async () => { requests++; }, beforeTurn: async () => undefined, boundary: async () => undefined,
  } });
  harness.state("chat").running = true;
  assert.match(await harness.handover("chat", "next"), /busy/);
  assert.equal(requests, 0);
});
