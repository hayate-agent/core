import assert from "node:assert/strict";
import {test} from "node:test";
import {Harness} from "../src/harness.js";
import {FakeRuntime,MemoryChannel,msg} from "./fakes.js";

function restored(state: "active"|"waiting"|"blocked"|"completed"|"stopped"="active") {
 const runtime=new FakeRuntime();const h=new Harness({runtime,tickMs:60000,now:()=>1000});
 h.addChannel(new MemoryChannel());h.onStateChange=async()=>{};
 h.restoreSessions([{key:"mem:room1",task:{id:"original",original:"Implement feature",state,next:"Run tests",depth:2},replyTo:{channel:"mem",target:"room1"}}]);
 return {h,runtime};
}
test("startup recovers one checkpointed next step and preserves original scope",async()=>{
 const {h,runtime}=restored();
 try {
  await h.recoverTasks();await h.recoverTasks();
  assert.equal(h.pendingInputs().length,1);
  assert.match(h.pendingInputs()[0].text,/Implement feature/);
  h.releaseRestored();await h.drained();
  assert.equal(runtime.sessions.get("mem:room1")?.prompts.length,1);
 }finally{await h.stop(1000);}
});
test("waiting, blocked, completed, stopped and expired tasks do not restart",async()=>{
 for(const state of ["waiting","blocked","completed","stopped"] as const){
  const {h}=restored(state);try{await h.recoverTasks();assert.equal(h.pendingInputs().length,0);}finally{await h.stop(1000);}
 }
 const {h}=restored();try{h.state("mem:room1").task!.expiresAt=999;await h.recoverTasks();assert.equal(h.pendingInputs().length,0);}finally{await h.stop(1000);}
});
test("queued operator input wins and stop revokes recovery durably",async()=>{
 const {h}=restored();try{
  await h.submit(msg("new instruction"),true);await h.recoverTasks();assert.equal(h.pendingInputs().length,1);
  await h.stopConversation("mem:room1");
  assert.equal(h.snapshotSessions()[0].task?.state,"stopped");
  await h.recoverTasks();assert.equal(h.pendingInputs().length,0);
 }finally{await h.stop(1000);}
});


test("pause survives recovery and pending continuation survives another restart",async()=>{
 const {h}=restored();h.paused=true;
 try{
  await h.recoverTasks();h.releaseRestored();
  assert.equal(h.pendingInputs().length,1);
  const sessions=JSON.parse(JSON.stringify(h.snapshotSessions()));
  const pending=JSON.parse(JSON.stringify(h.pendingInputs()));
  const next=new Harness({runtime:new FakeRuntime(),tickMs:60000});
  next.addChannel(new MemoryChannel());next.onStateChange=async()=>{};next.paused=true;
  try{
   next.restoreSessions(sessions);next.restorePending(pending);await next.recoverTasks();
   assert.equal(next.pendingInputs().length,1);
   next.releaseRestored();assert.equal(next.pendingInputs().length,1);
   next.resume();await next.drained();assert.equal(next.pendingInputs().length,0);
  }finally{await next.stop(1000);}
 }finally{await h.stop(1000);}
});

test("failed recovery save does not leave an executable or duplicate input",async()=>{
 const {h}=restored();
 try{
  h.onStateChange=async()=>{throw Error("disk full");};
  await assert.rejects(h.recoverTasks(),/disk full/);assert.equal(h.pendingInputs().length,0);
  h.onStateChange=async()=>{};await h.recoverTasks();assert.equal(h.pendingInputs().length,1);
 }finally{await h.stop(1000);}
});

test("unrelated scheduled turn cannot overwrite a waiting task checkpoint",async()=>{
 const {h}=restored("blocked");
 try{
  await h.submit({...msg("scheduled maintenance"),source:"cron"});await h.drained();
  assert.equal(h.snapshotSessions()[0].task?.state,"blocked");
  assert.equal(h.snapshotSessions()[0].task?.original,"Implement feature");
 }finally{await h.stop(1000);}
});


test("restart from committed completion resumes only the already queued next step",async()=>{
 let h:Harness;let turns=0;
 h=new Harness({runtime:new FakeRuntime(()=>{
  turns++;h.planContinuation("mem:room1",{state:"continue",next:"verify remaining tests"});return "first side effect completed";
 }),tickMs:60000});
 h.addChannel(new MemoryChannel());
 let checkpoint:{sessions:any[];pending:any[];outbox:any[]}|undefined;
 h.onStateChange=async()=>{};
 try {
  h.onStateChange=async()=>{
   if(h.state("mem:room1").task?.next && !checkpoint){
    h.paused=true;
    checkpoint=JSON.parse(JSON.stringify({sessions:h.snapshotSessions(),pending:h.pendingInputs(),outbox:h.outboxEntries()}));
   }
  };
  await h.submit(msg("implement original feature"));
  for(let i=0;i<100&&!checkpoint;i++)await new Promise(r=>setTimeout(r,1));
  assert.ok(checkpoint);assert.equal(turns,1);assert.equal(checkpoint.pending.length,1);
  assert.equal(checkpoint.pending[0].taskId,checkpoint.sessions[0].task.id);
  const runtime=new FakeRuntime();const next=new Harness({runtime,tickMs:60000});
  next.addChannel(new MemoryChannel());next.onStateChange=async()=>{};
  try{
   next.restoreSessions(checkpoint.sessions);next.restorePending(checkpoint.pending);next.restoreOutbox(checkpoint.outbox);
   await next.recoverTasks();assert.equal(next.pendingInputs().length,1);
   next.releaseRestored();await next.drained();
   assert.equal(runtime.sessions.get("mem:room1")?.prompts.length,1);
   assert.match(runtime.sessions.get("mem:room1")!.prompts[0],/verify remaining tests/);
  }finally{await next.stop(1000);}
 }finally{await h.stop(0);}
});
