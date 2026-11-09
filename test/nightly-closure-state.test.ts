import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController } from "./improvement-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

for (const value of [-1, 4, 0.5, "2", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid persisted closureFailures ${JSON.stringify(value)} fails before inference or writes`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nightly-invalid-counter-"));
    await mkdir(path.join(home, "improvement"));
    const file = path.join(home, "improvement/state.json");
    const original = JSON.stringify({ version: 1, night: "2026-10-24", turns: 2, results: [], closureFailures: value });
    await writeFile(file, original);
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000 });
    let reviews = 0;
    const c = new ImprovementController(home, h, "UTC", () => Date.parse("2026-10-24T23:00:00Z"), async () => {
      reviews++; return { state: "completed" };
    });
    try {
      await assert.rejects(c.tick(), /Invalid nightly closure failure counter/);
      assert.equal(await readFile(file, "utf8"), original);
      assert.equal(reviews, 0); assert.equal(runtime.opened.length, 0);
      assert.equal(h.pendingInputs().length, 0);
    } finally { await h.stop(1000); await rm(home, { recursive: true, force: true }); }
  });
}

for (const value of [undefined, 0, 1, 2, 3]) {
  test(`legacy or valid persisted closureFailures ${String(value)} remains unchanged`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nightly-valid-counter-"));
    await mkdir(path.join(home, "improvement"));
    await writeFile(path.join(home, "improvement.yaml"), "enabled: false\n");
    const file = path.join(home, "improvement/state.json");
    const original = JSON.stringify({ version: 1, night: "2026-10-24", turns: 2, results: [],
      ...(value !== undefined ? { closureFailures: value } : {}) });
    await writeFile(file, original);
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000 });
    const c = new ImprovementController(home, h, "UTC", () => Date.parse("2026-10-24T23:00:00Z"));
    try {
      await c.tick();
      assert.equal(await readFile(file, "utf8"), original);
      assert.equal(runtime.opened.length, 0); assert.equal(h.pendingInputs().length, 0);
    } finally { await h.stop(1000); await rm(home, { recursive: true, force: true }); }
  });
}
