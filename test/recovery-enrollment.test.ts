import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness, type DurableTask } from '../src/harness.js';
import type { Inbound } from '../src/types.js';
import { FakeRuntime } from './fakes.js';
import { ExecutionStore } from '../src/execution.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const key='main';
const old=():DurableTask=>({id:'old',original:'Old request',state:'active',depth:0,next:'Old step'});
const queued=():Inbound=>({id:'task:old:1',sessionKey:key,source:'cron',taskId:'old',continuationDepth:1,text:'Old step'});
function make(){let assessments=0;const runtime=new FakeRuntime();const h=new Harness({runtime,now:()=>1000,completionCheck:async()=>{assessments++;return {state:'completed'};}});h.onStateChange=async()=>{};return{h,runtime,assessments:()=>assessments};}

test('upgrade holds unresolved history and saves its generated inbox without executing it',async t=>{
 const f=make();t.after(()=>f.h.stop(0));const task=old();task.recoveryAdmission={id:'task:old:1',depth:1,next:task.next!,original:task.original};
 f.h.restoreSessions([{key,tasks:[task]}]);f.h.holdLegacyRecovery([queued()]);f.h.restorePending([queued()]);
 await f.h.recoverTasks();f.h.releaseRestored();await f.h.tick();await f.h.drained();
 const s=f.h.snapshotSessions()[0]!;assert.equal(s.tasks![0]!.recoveryEnrollment,'held-legacy');assert.equal(s.tasks![0]!.recoveryHeldState,'active');assert.equal(s.tasks![0]!.state,'blocked');assert.equal(s.heldRecoveryInputs!.length,1);assert.equal(f.h.pendingInputs().length,0);assert.equal(f.assessments(),0);assert.equal(f.runtime.opened.length,0);
 const next=make();t.after(()=>next.h.stop(0));next.h.restoreSessions(JSON.parse(JSON.stringify(f.h.snapshotSessions())));next.h.holdLegacyRecovery([]);await next.h.recoverTasks();await next.h.tick();assert.equal(next.assessments(),0);assert.equal(next.h.snapshotSessions()[0]!.heldRecoveryInputs!.length,1);
});

test('terminal pre-upgrade history stays terminal and cannot gain authority from a late result',async t=>{
 const f=make();t.after(()=>f.h.stop(0));f.h.restoreSessions([{key,tasks:[{...old(),state:'completed'},{...old(),id:'stopped',state:'stopped'}]}]);f.h.holdLegacyRecovery([]);
 const rows=f.h.snapshotSessions()[0]!.tasks!;assert.deepEqual(rows.map(t=>t.state),['completed','stopped']);assert.ok(rows.every(t=>t.recoveryEnrollment==='held-legacy'));
 await f.h.recoverTasks();await f.h.tick();assert.equal(f.assessments(),0);
});

test('authentic unfinished operator ingress remains current, unlike generated permits',async t=>{
 const f=make();t.after(()=>f.h.stop(0));f.h.restoreSessions([{key,tasks:[old()]}]);
 f.h.holdLegacyRecovery([{id:'old',sessionKey:key,source:'channel',text:'Old request',started:true}]);
 assert.equal(f.h.snapshotSessions()[0]!.tasks![0]!.recoveryEnrollment,'current');
});

test('exact ongoing child survives upgrade without granting unrelated old parents authority',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'recovery-enrollment-'));const store=new ExecutionStore(path.join(dir,'executions.json'));await store.load();
 const a=old();await store.submit(key,'req','work','direct',1,{taskId:a.id,original:a.original,depth:0});const other={...old(),id:'other'};
 const h=new Harness({runtime:new FakeRuntime(),executionStore:store});t.after(async()=>{await h.stop(0);await rm(dir,{recursive:true,force:true});});h.restoreSessions([{key,tasks:[a,other]}]);h.holdLegacyRecovery([]);
 assert.deepEqual(h.snapshotSessions()[0]!.tasks!.map(t=>t.recoveryEnrollment),['current','held-legacy']);assert.equal(store.list()[0]!.status,'ready');
});

test('new host-created tasks persist current enrollment',async t=>{
 const f=make();t.after(()=>f.h.stop(0));await f.h.accept({id:'new',sessionKey:key,source:'channel',text:'new request'});await f.h.waitForSessionIdle(key);
 assert.equal(f.h.snapshotSessions()[0]!.tasks!.find(t=>t.id==='new')!.recoveryEnrollment,'current');
});

test('explicit resume enrolls only the exact held task, not its archived queue',async t=>{
 const f=make();t.after(()=>f.h.stop(0));f.h.restoreSessions([{key,tasks:[old(),{...old(),id:'other'}]}]);f.h.holdLegacyRecovery([queued()]);f.h.restorePending([queued()]);
 await f.h.resumeHeldTask(key,'old');const s=f.h.snapshotSessions()[0]!;assert.equal(s.tasks![0]!.recoveryEnrollment,'current');assert.equal(s.tasks![1]!.recoveryEnrollment,'held-legacy');assert.equal(s.heldRecoveryInputs!.length,1);assert.equal(f.h.pendingInputs().length,0);
});

for(const mode of ['deadline','stopped','exhausted','save']as const)test(`explicit resume preserves ${mode} fence`,async t=>{
 const f=make();t.after(()=>f.h.stop(0));const a=old();if(mode==='deadline')a.expiresAt=999;if(mode==='stopped')a.state='stopped';if(mode==='exhausted')a.depth=20;
 f.h.restoreSessions([{key,tasks:[a]}]);f.h.holdLegacyRecovery([]);if(mode==='save')f.h.onStateChange=async()=>{throw Error('disk');};await assert.rejects(f.h.resumeHeldTask(key,'old'));
 if(mode==='save')assert.equal(f.h.snapshotSessions()[0]!.tasks![0]!.recoveryEnrollment,'held-legacy');
});
