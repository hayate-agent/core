import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { initialize, diagnose } from "../src/setup.js";
import { loadConfig } from "../src/config.js";

test("native initialization writes configurable identity and workspace without overwriting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-init-"));
  const home = path.join(dir, "agent");
  try {
    assert.equal((await initialize({ home, cwd: dir, agent: "builder", model: "provider/model" })).length, 3);
    const config = await loadConfig(home);
    assert.equal(config.cwd, dir);
    assert.equal(config.agent, "builder");
    assert.equal(config.model, "provider/model");
    assert.ok(config.tools?.includes("bash"));
    await writeFile(path.join(home, "SOUL.md"), "my identity");
    assert.deepEqual(await initialize({ home, cwd: dir, agent: "other" }), []);
    assert.equal(await readFile(path.join(home, "SOUL.md"), "utf8"), "my identity");
    assert.equal((await diagnose(home)).ok, true);
    const file = path.join(dir, "not-a-directory");
    await writeFile(file, "file");
    await assert.rejects(initialize({ home: path.join(dir, "invalid-profile"), cwd: file }), /not a directory/);
    await writeFile(path.join(home, "hayate-agent.yaml"), `cwd: ${JSON.stringify(file)}\n`);
    assert.equal((await diagnose(home)).ok, false);
    await rm(path.join(home, "hayate-agent.yaml"));
    assert.equal((await diagnose(home)).ok, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
