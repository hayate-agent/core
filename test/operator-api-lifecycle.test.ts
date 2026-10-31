import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ApiChannel } from "../src/api/server.js";
import { RunRegistry } from "../src/api/runs.js";
import type { Inbound } from "../src/types.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("expected lifecycle boundary was not reached");
}

for (const busyMode of ["queue", "steer", "interrupt"] as const) {
  for (const source of ["host", "cron", "api"] as const) {
    test(`${busyMode}/${source}: API runs retain individual prompts and durable terminal delivery amid channel inputs`, { timeout: 10000 }, async t => {
      const home = await mkdtemp(path.join(os.tmpdir(), "operator-api-"));
      t.after(() => rm(home, { recursive: true, force: true }));
      const key = "mem:room1";
      const runtime = new FakeRuntime();
      const runs = new RunRegistry(path.join(home, "runs.json"));
      const harness = new Harness({ runtime, busyMode, tickMs: 60000, hostEventAllowed: () => true });
      const channel = new MemoryChannel();
      const api = new ApiChannel({ key: "local-test-only", agent: "test", runs,
        cancel: (k, id) => harness.cancel(k, id), models: async () => [], defaultModel: () => undefined });
      harness.addChannel(channel); harness.addChannel(api);
      const inboxFile = path.join(home, "inbox.json");
      harness.onStateChange = async () => { await writeFile(inboxFile, JSON.stringify(harness.pendingInputs())); };
      t.after(() => harness.stop(1000));
      const makeRun = async (text: string): Promise<Inbound> => {
        const run = runs.create({ session_key: key, session_id: "shared" });
        await runs.save();
        return { id: run.input_id, sessionKey: key, source: "api", text,
          replyTo: { channel: "api", target: run.run_id }, turn: { instructions: `instructions:${text}` } };
      };
      await harness.sessionFor(key);
      const session = runtime.sessions.get(key)!;
      let release = session.hold();
      const current: Inbound = source === "api" ? await makeRun("current-api") : {
        id: "background", sessionKey: key, source, text: "background", replyTo: ROOM,
        ...(source === "host" ? { hostEvent: { executionId: "child-result" } } : {}),
      };
      await harness.accept(current);
      await until(() => session.prompts.length === 1);
      const one = await makeRun("api-one"), two = await makeRun("api-two");
      await harness.accept(one);
      // A channel question must not consume or interrupt an API lifecycle either.
      await harness.accept({ ...msg("question"), id: "question" });
      await harness.accept(two);
      assert.equal(session.aborted, 0);
      assert.ok(!session.steered.includes("api-one") && !session.steered.includes("api-two"));
      const saved = JSON.parse(await readFile(inboxFile, "utf8")) as Inbound[];
      for (const input of [current, one, two]) assert.ok(saved.some(item => item.id === input.id), `${input.text} durable`);
      assert.equal(runs.get(one.replyTo!.target)!.status, "queued");
      assert.equal(runs.get(two.replyTo!.target)!.status, "queued");

      // Hold the first API prompt too: more channel/API traffic arriving while
      // an API is current must queue, even in steer and interrupt modes.
      const originalPrompt = session.prompt.bind(session);
      let active = 0, maxActive = 0;
      let releaseOne!: () => void;
      session.prompt = async (text, options) => {
        active++; maxActive = Math.max(maxActive, active);
        if (text === "api-one") releaseOne = session.hold();
        try { return await originalPrompt(text, options); } finally { active--; }
      };
      release();
      await until(() => session.prompts.includes("api-one"));
      await harness.accept({ ...msg("later question"), id: "later-question" });
      const three = await makeRun("api-three");
      await harness.accept(three);
      assert.equal(session.aborted, 0);
      assert.ok(!session.steered.includes("later question"));
      const duringApi = JSON.parse(await readFile(inboxFile, "utf8")) as Inbound[];
      for (const input of [one, two, three]) assert.ok(duringApi.some(item => item.id === input.id));
      releaseOne();
      await harness.drained();
      assert.equal(maxActive, 1);
      assert.equal(session.aborted, 0);
      assert.deepEqual(session.prompts.filter(text => text.startsWith("api-")), ["api-one", "api-two", "api-three"]);
      assert.ok(channel.texts().includes("echo: later question"));
      for (const input of [one, two, three, ...(source === "api" ? [current] : [])]) {
        const run = runs.get(input.replyTo!.target)!;
        assert.equal(run.status, "completed");
        assert.equal(run.output, `echo: ${input.text}`);
        const index = session.prompts.indexOf(input.text);
        assert.ok(session.options[index].instructions!.startsWith(`instructions:${input.text}\n`));
        assert.match(session.options[index].instructions!, /20 consecutive productive attempts without fresh host evidence/);
      }
      assert.deepEqual(harness.pendingInputs(), []);
      const restored = new RunRegistry(path.join(home, "runs.json"));
      await restored.load();
      for (const input of [one, two, three]) assert.equal(restored.get(input.replyTo!.target)!.status, "completed");
    });
  }
}
