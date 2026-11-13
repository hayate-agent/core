import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startupQualificationProgram } from "../src/startup-qualification.js";
const run = promisify(execFile);
for (const provider of [undefined, "legacy-llm", false, "invalid/provider"] as const) test(`candidate-owned read-only configuration qualification: ${String(provider)}`, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "startup-config-"));
  try {
    const config = provider === undefined ? "agent: fixture\n" : `agent: fixture\ncompletionCheck:\n  provider: ${provider}\n`;
    await writeFile(path.join(home, "hayate-agent.yaml"), config);
    const program = startupQualificationProgram(path.resolve("."), home);
    if (provider === undefined || provider === "invalid/provider") await assert.rejects(run(process.execPath, ["--input-type=module", "--eval", program]));
    else await run(process.execPath, ["--input-type=module", "--eval", program]);
    assert.deepEqual(await readdir(home), ["hayate-agent.yaml"], "no credentials, sessions, model work or ledgers created");
  } finally { await rm(home, { recursive: true, force: true }); }
});
