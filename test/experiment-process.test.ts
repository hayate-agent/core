import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { runExperimentProcess } from "../src/experiment-process.js";
const options = { cwd: os.tmpdir(), timeout: 1000, maxBuffer: 1024 };
test("runner handles success, nonzero, overflow, timeout and spawn errors", async () => {
  assert.equal((await runExperimentProcess(process.execPath, ["-e", "process.stdout.write('ok')"], options)).stdout, "ok");
  await assert.rejects(runExperimentProcess(process.execPath, ["-e", "process.exit(3)"], options), /failed/);
  await assert.rejects(runExperimentProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], options), /output limit/);
  await assert.rejects(runExperimentProcess(process.execPath, ["-e", "process.stderr.write('x'.repeat(2048))"], options), /output limit/);
  await assert.rejects(runExperimentProcess(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { ...options, timeout: 150 }), /timed out/);
  await assert.rejects(runExperimentProcess("/nonexistent/sample-test-executable", [], options), /ENOENT/);
});
test("POSIX normal exit and timeout clean ordinary descendants", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp("/tmp/sample-group-test-");
  const live = async (pid: number) => {
    try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; }
    catch (err) { if (["ENOENT", "ESRCH"].includes((err as NodeJS.ErrnoException).code ?? "")) return false; throw err; }
  };
  try {
    for (const timeout of [false, true]) {
      let pid: number | undefined;
      try {
        const file = root + `/child-${timeout}.pid`;
        const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(file)},String(c.pid));${timeout ? "setTimeout(()=>{},5000)" : "c.unref()"};`;
        const run = runExperimentProcess(process.execPath, ["-e", script], { ...options, timeout: 500 });
        if (timeout) await assert.rejects(run, /timed out/); else await run;
        pid = Number(await readFile(file, "utf8"));
        for (let i = 0; i < 50 && await live(pid); i++) await new Promise((r) => setTimeout(r, 10));
        assert.equal(await live(pid), false);
      } finally { if (pid && await live(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
