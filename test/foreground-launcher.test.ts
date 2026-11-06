import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runForeground } from "../src/launcher.js";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

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

test("foreground termination waits for graceful child cleanup and does not restart exit 75", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "foreground-signal-"));
  try {
    const entry = path.join(root, "runtime.cjs"), ready = path.join(root, "ready"), done = path.join(root, "done");
    await writeFile(entry, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(ready)},'started\\n');
process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},'cleaned');process.exit(75)},100));setInterval(()=>{},1000);`);
    const module = pathToFileURL(path.resolve("src/launcher.ts")).href;
    const code = `const {runForeground}=await import(${JSON.stringify(module)});process.exitCode=await runForeground(${JSON.stringify(entry)},[],[]);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: "ignore" });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    let found = false;
    for (let i = 0; i < 200; i++) { try { found = (await readFile(ready, "utf8")) === "started\n"; if (found) break; } catch {} await new Promise(r => setTimeout(r, 10)); }
    assert.ok(found);
    child.kill("SIGTERM");
    assert.equal(await exited, 143);
    assert.equal(await readFile(done, "utf8"), "cleaned");
    assert.equal(await readFile(ready, "utf8"), "started\n");
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
