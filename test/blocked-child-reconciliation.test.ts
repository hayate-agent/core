import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm, writeFile, readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Harness, type DurableTask} from "../src/harness.js";
import {ExecutionStore} from "../src/execution.js";
import {FakeRuntime, MemoryChannel} from "./fakes.js";

async function fixture(t: {after(fn:()=>Promise<void>):void}, status = "blocked") {
 const home = await mkdtemp(path.join(os.tmpdir(), "blocked-child-"));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const file = path.join(home,"executions.json");
 const store = new ExecutionStore(file); await store.load();
 const child = await store.submit("mem:room1","child","Implement routing","direct",1,
  {taskId:"parent",depth:0,original:"Fix routing"});
 let effects = 0;
 const claimed = await store.claim(child.id);
 if (status === "blocked") {
  await store.intent(child.id, claimed.token!, "worktree-edit", "unsafe");
  // Fake worker: some real work succeeded, then its model backend returned 503.
  await writeFile(path.join(home,"worktree.txt"),"partial routing edit"); effects++;
  const backend = {review:async()=>{throw Error("HTTP 503 no healthy upstream");}};
  await assert.rejects(backend.review(),/503 no healthy upstream/);
  await store.fail(child.id,claimed.token!,"worker-failed");
 } else if (status === "ready") {
  await store.fail(child.id,claimed.token!,"worker-failed"); await store.control(child.id,"resume");
 } else if (status === "paused") await store.ask(child.id,claimed.token!,"Which target?");
 const runtime = new FakeRuntime();
 let calls = 0;
 let assess: NonNullable<ConstructorParameters<typeof Harness>[0]["completionCheck"]> = async (_input, evidence) => {
  calls++; assert.match(evidence,/worktree-edit/); assert.match(evidence,/worker-failed/);
  return {state:"continue", next:"Independently inspect the operator's original routing requirements"};
 };
 const h = new Harness({runtime, executionStore:store, now:()=>1000, tickMs:60000,
  completionCheck:(...args)=>assess(...args)});
 h.addChannel(new MemoryChannel());
 let saved: ReturnType<Harness["snapshotSessions"]> | undefined;
 h.onStateChange=async()=>{saved=structuredClone(h.snapshotSessions());};
 const task:DurableTask={id:"parent",original:"Fix routing",state:"active",depth:0};
 h.restoreSessions([{key:"mem:room1",task,replyTo:{channel:"mem",target:"room1"}}]);
 t.after(()=>h.stop(0));
 return {h,store,child,claimed,runtime,file,home,effects,calls:()=>calls,saved:()=>saved!,
  assess:(fn:typeof assess)=>{assess=fn;}, task:()=>h.snapshotSessions()[0]!.task!};
}

test("503 after work: durable decision checkpoint, no child replay or productive parent admission",async t=>{
 const f=await fixture(t);
 const before=await readFile(f.file,"utf8");
 await f.h.recoverTasks(); await f.h.recoverTasks(); await f.h.tick();
 assert.equal(f.calls(),1);
 const receipt=f.task().supervisorDecision!;
 assert.equal(receipt.dependencyHold?.reason,"independent-next-proposed");
 assert.match(receipt.dependencyHold?.next??"",/Independently/);
 assert.equal(f.task().next,undefined); assert.equal(f.task().recoveryAdmission,undefined);
 assert.equal(f.h.pendingInputs().length,0); assert.equal(f.runtime.sessions.size,0);
 assert.equal(await readFile(f.file,"utf8"),before); assert.equal(f.effects,1);
 assert.equal(await readFile(path.join(f.home,"worktree.txt"),"utf8"),"partial routing edit");
 await assert.rejects(f.store.claim(f.child.id));
 await assert.rejects(f.store.complete(f.child.id,f.claimed.token!,"late"));
 const runtime=new FakeRuntime();let calls=0;
 const restarted=new Harness({runtime,executionStore:f.store,now:()=>1000,
  completionCheck:async()=>{calls++;return {state:"continue",next:"unsafe"};}});
 restarted.onStateChange=async()=>{}; restarted.restoreSessions(f.saved());
 try {await restarted.recoverTasks();assert.equal(calls,0);assert.equal(restarted.pendingInputs().length,0);}
 finally{await restarted.stop(0);}
});

for(const status of ["ready","running","paused"]) test(`truly ${status} child stays fenced before assessment`,async t=>{
 const f=await fixture(t,status);await f.h.recoverTasks();await f.h.tick();
 assert.equal(f.calls(),0);assert.equal(f.h.pendingInputs().length,0);
});

test("separate retained mandate is not held by blocked child's decision checkpoint",async t=>{
 const f=await fixture(t);
 const other:DurableTask={id:"other",original:"Run isolated tests",state:"active",depth:0,next:"Run isolated tests",
  recoveryAdmission:{id:"task:other:1",depth:1,next:"Run isolated tests",original:"Run isolated tests"}};
 f.h.restoreSessions([{key:"mem:room1",tasks:[f.task(),other],replyTo:{channel:"mem",target:"room1"}}]);
 await f.h.recoverTasks();assert.equal(f.calls(),1);
 assert.equal(f.h.pendingInputs().length,1);assert.equal(f.h.pendingInputs()[0]!.taskId,"other");
});

test("technical 503 in assessor is a durable hold, not automatic retry or progress",async t=>{
 const f=await fixture(t);let calls=0;
 f.assess(async()=>{calls++;throw Error("HTTP 503 no healthy upstream");});
 await f.h.recoverTasks();await f.h.recoverTasks();await f.h.tick();
 assert.equal(calls,1);assert.equal(f.task().supervisorDecision?.dependencyHold?.reason,"global-hold");
 assert.equal(f.task().supervisorDecision?.diagnostic,"technical");assert.equal(f.task().depth,0);
});

test("stale assessor result after child cancellation is discarded",async t=>{
 const f=await fixture(t);
 f.assess(async()=>{await f.store.control(f.child.id,"cancel");return {state:"continue",next:"stale"};});
 await f.h.recoverTasks();
 assert.equal(f.task().supervisorDecision?.dependencyHold?.reason,"assessment-claimed");
 assert.equal(f.task().supervisorDecision?.dependencyHold?.next,undefined);
});

test("pause during inference discards proposal without granting productive admission",async t=>{
 const f=await fixture(t);
 f.assess(async()=>{f.h.paused=true;return {state:"continue",next:"stale"};});
 await f.h.recoverTasks();
 assert.equal(f.task().supervisorDecision?.dependencyHold?.reason,"assessment-claimed");
 assert.equal(f.task().next,undefined);assert.equal(f.h.pendingInputs().length,0);
});

test("failed persistence never invokes assessor and retained claim prevents repeated inference",async t=>{
 const f=await fixture(t);f.h.onStateChange=async()=>{throw Error("disk unavailable");};
 await assert.rejects(f.h.recoverTasks(),/disk unavailable/);assert.equal(f.calls(),0);
 f.h.onStateChange=async()=>{};await f.h.recoverTasks();assert.equal(f.calls(),0);
});

for(const condition of ["expiry","budget","queue","pause"]) test(`${condition} prevents checkpoint inference`,async t=>{
 const f=await fixture(t);const task=f.task();
 if(condition==="expiry") task.expiresAt=999;
 if(condition==="budget") task.depth=20;
 if(condition==="pause") f.h.paused=true;
 f.h.restoreSessions([{key:"mem:room1",task}]);
 if(condition==="queue") f.h.restorePending([{source:"channel",sessionKey:"mem:room1",text:"new work"}]);
 await f.h.recoverTasks();assert.equal(f.calls(),0);
});
