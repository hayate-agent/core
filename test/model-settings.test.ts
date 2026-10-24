import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateModelSetting } from "../src/model-settings.js";
import { StateStore } from "../src/state.js";

test("model overrides validate and persist independently of configuration", async (t) => {
  assert.throws(() => validateModelSetting("model", "missing-provider"));
  assert.throws(() => validateModelSetting("reviewThinking", "invented"));
  validateModelSetting("reviewModel", "homelab/gpt-6.1-sol");
  validateModelSetting("thinking", "medium");
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const modelSettings = { model: "p/a", thinking: "high", reviewModel: "p/b", reviewThinking: "medium" };
  await new StateStore(file).save({ version: 1, paused: false, busyMode: "queue", sessions: [], modelSettings });
  assert.deepEqual((await new StateStore(file).load())?.modelSettings, modelSettings);
});
