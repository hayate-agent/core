import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("real PI seed retry after failed checkpoint and reopen does not duplicate handover", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "handover-seed-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import {PiRuntime} from './src/runtime/pi.ts';
import {FilesystemSessionProvider} from './src/sessions.ts';
import {ContextMaintenance,contextPolicy} from './src/context-maintenance.ts';
const backend=new FilesystemSessionProvider(process.env.TEST_HOME+'/store');
const save=backend.save.bind(backend);let fail=false, saves=0;
backend.save=async(...args)=>{saves++;if(fail)throw Error('fixture checkpoint unavailable');return save(...args);};
const options={cwd:process.env.TEST_HOME,sessionsDir:process.env.TEST_HOME+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},sessionProvider:()=>backend};
const runtime=new PiRuntime(options);
let session=await runtime.open('conversation');
fail=true;
await assert.rejects(session.seedHandover('preserve original continuation'),/fixture checkpoint unavailable/);
assert.equal(session.session.sessionManager.getBranch().filter(e=>e.type==='custom_message' && e.customType==='harness-handover').length,1);
fail=false;const before=saves;
await session.seedHandover('preserve original continuation');
assert.ok(saves>before,'retry must still checkpoint an existing in-memory seed');
assert.equal(session.session.sessionManager.getBranch().filter(e=>e.type==='custom_message' && e.customType==='harness-handover').length,1,'checkpoint retry must not append duplicate seed');
await session.dispose();
session=await runtime.open('conversation');
await session.seedHandover('preserve original continuation');
assert.equal(session.session.sessionManager.getBranch().filter(e=>e.type==='custom_message' && e.customType==='harness-handover').length,1,'restart/archive-link recovery must not append duplicate seed');
await session.seedHandover('a genuinely different handover');
assert.equal(session.session.sessionManager.getBranch().filter(e=>e.type==='custom_message' && e.customType==='harness-handover').length,2,'different seed must not be suppressed');
await session.dispose();
// Exercise the real prepared -> rotated/seeded -> link-failed -> reopened ->
// guidance-recovered boundary. Only the summary is a deterministic fixture;
// PI messages, provider snapshots and archive linkage are real.
const maintenance=new ContextMaintenance(process.env.TEST_HOME,()=>contextPolicy());
await maintenance.request('recovery',{action:'handover',preserve:'operator scope',resume:'pending continuation'});
maintenance.archives.link=async()=>{throw Object.assign(Error('fixture archive unavailable'),{code:'EIO'});};
const old={status:()=>({sessionId:'old-fixture'}),summarize:async()=> 'summary fixture',archiveEntries:()=>[]};
let next,rotations=0;
await maintenance.beforeTurn('recovery',old,async handover=>{
 rotations++;next=await runtime.open('recovery',{fresh:true});await next.seedHandover(handover.text);return next;
});
const failed=await maintenance.status('recovery');
assert.equal(failed.failure.stage,'archive-link');assert.equal(failed.handover.phase,'prepared');assert.ok(failed.pending);
await next.dispose();next=await runtime.open('recovery');
const recovered=new ContextMaintenance(process.env.TEST_HOME,()=>contextPolicy(),undefined,()=>Date.now()+1001);
await recovered.guidance('recovery',next);
assert.equal(next.session.sessionManager.getBranch().filter(e=>e.type==='custom_message' && e.customType==='harness-handover').length,1,'archive-link retry must preserve a single seed across reopen');
const done=await recovered.status('recovery');
assert.equal(done.handover.phase,'switched');assert.equal(done.pending,undefined);assert.equal(done.failure,undefined);assert.equal(rotations,1);
const archive=await recovered.archives.load('recovery',done.handover.archiveId);
assert.equal(archive.targetSessionId,next.status().sessionId);assert.match(archive.forward,/pending continuation/);
await next.dispose();
console.log('HANDOVER_SEED_RECOVERY_OK');`;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_HOME: home }, timeout: 30000,
    });
    assert.match(result.stdout, /HANDOVER_SEED_RECOVERY_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
