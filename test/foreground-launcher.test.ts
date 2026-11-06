import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runForeground } from "../src/launcher.js";

test("foreground restart waits for the old owner, retains arguments and the requested session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "foreground-restart-"));
  try {
    const entry = path.join(root, "runtime.cjs");
    await writeFile(entry, `const fs=require('fs'),p=${JSON.stringify(path.join(root, "calls"))};
const rows=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):[];
rows.push({pid:process.pid,args:process.argv.slice(2),session:process.env.HAYATE_RESTART_SESSION});fs.writeFileSync(p,JSON.stringify(rows));
if(rows.length===1){process.send({type:'hayate-restart',session:'12345678-1234-1234-1234-123456789abc'});process.exitCode=75;}
else{try{process.kill(rows[0].pid,0);process.exitCode=9;}catch{process.exitCode=0;}}`);
    assert.equal(await runForeground(entry, ["run", "--home", "a path"], []), 0);
    const rows = JSON.parse(await readFile(path.join(root, "calls"), "utf8"));
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].pid, rows[1].pid);
    assert.deepEqual(rows.map((r: any) => r.args), [["run", "--home", "a path"], ["run", "--home", "a path"]]);
    assert.equal(rows[1].session, "12345678-1234-1234-1234-123456789abc");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const code of [0, 1, 3]) test(`foreground exit ${code} is not a restart request`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "foreground-exit-"));
  try {
    const entry = path.join(root, "runtime.cjs");
    await writeFile(entry, `require('fs').appendFileSync(${JSON.stringify(path.join(root, "calls"))},'called\\n');process.exit(${code});`);
    assert.equal(await runForeground(entry, [], []), code);
    assert.equal(await readFile(path.join(root, "calls"), "utf8"), "called\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
