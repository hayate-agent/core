import assert from "node:assert/strict";
import {test} from "node:test";
import {Harness} from "../src/harness.js";
import {FakeRuntime,MemoryChannel,ROOM} from "./fakes.js";
import {Subagents,type SubagentHandover} from "../src/subagents.js";
async function until(check:()=>boolean):Promise<void> {
 for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}
 assert.fail("condition did not become true");
}
test("child approvals reach parent, never become results, and preserve approve/deny decisions",async()=>{
 let manager!:Subagents;
 const h=new Harness({runtime:new FakeRuntime(()=>"done"),tickMs:60000,approvalTarget:key=>manager.approvalTarget(key)});
 h.paused=true;h.onStateChange=async()=>{};
 manager=new Subagents(h,async()=>{});const channel=new MemoryChannel();h.addChannel(channel);h.addChannel(manager.channel);
 h.state("parent").replyTo=ROOM;
 try {
  const child=await manager.start("parent",handover);
  await assert.rejects(manager.channel.send({channel:"subagents",target:child.id},"approval",{approvalId:"wrong"}),/trusted/);
  for (const allowed of [true,false]) {
   const result=h.requestApproval(child.sessionKey,"bash",{command:"danger"});
   await until(()=>h.approvals.size===1);
   const approval=[...h.approvals.values()][0];
   assert.equal(channel.sent.at(-1)?.to.target,ROOM.target);
   assert.equal(channel.sent.at(-1)?.meta?.approvalId,approval.id);
   assert.equal(manager.get("parent",child.id).state,"queued");
   assert.equal(manager.get("parent",child.id).result,undefined);
   approval.resolve(allowed);assert.equal(await result,allowed);
  }
  h.resume();await h.drained();
 } finally {await h.stop(1000);}
});

test("child deadline cancels running work and parent stop cancels queued children",async()=>{
 const runtime=new FakeRuntime();let manager!:Subagents;
 const h=new Harness({runtime,tickMs:60000,conversationStopped:key=>manager.cancelChildren(key),
  beforeTurn:async input=>{if(input.sessionKey.startsWith("subagent:")) {
   const session=await runtime.open(input.sessionKey);session.hold();h.state(input.sessionKey).session=session;
  }}});
 h.onStateChange=async()=>{};manager=new Subagents(h,async()=>{},100);h.addChannel(manager.channel);
 try {
  const child=await manager.start("parent",handover);
  await until(()=>runtime.sessions.get(child.sessionKey)?.busy===true);
  const approval=h.requestApproval(child.sessionKey,"bash",{});
  await until(()=>h.approvals.size===1);
  await until(()=>manager.get("parent",child.id).state==="cancelled");
  assert.equal(await approval,false);await h.drained();
  assert.ok(runtime.sessions.get(child.sessionKey)!.aborted>0);
  h.paused=true;
  const queued=await manager.start("parent",handover);
  await h.stopConversation("parent");
  assert.equal(manager.get("parent",queued.id).state,"cancelled");
  assert.throws(()=>manager.guardTool(queued.sessionKey,"plugin_loop"),/authorized/);
  assert.throws(()=>manager.guardTool(queued.sessionKey,"plugin_task_continuation"),/authorized/);
 }finally{await h.stop(1000);}
});

test("restart reconciliation fails orphaned starts closed without resubmission",async()=>{
 const h=new Harness({runtime:new FakeRuntime(),tickMs:60000});h.paused=true;h.onStateChange=async()=>{};
 const manager=new Subagents(h,async()=>{});h.addChannel(manager.channel);
 try {
  const child=await manager.start("parent",handover);
  const restoredHarness=new Harness({runtime:new FakeRuntime(),tickMs:60000});
  const restored=new Subagents(restoredHarness,async()=>{});restored.restore(manager.snapshot());
  await restored.reconcile();
  assert.equal(restored.get("parent",child.id).state,"failed");
  assert.equal(restoredHarness.pendingInputs().length,0);
  await restoredHarness.stop(1000);
 }finally{await h.stop(1000);}
});
const handover:SubagentHandover={task:"test feature",context:"approved feature",constraints:"no deployment",expectedResult:"test evidence",acceptance:"tests pass",model:"provider/small",thinking:"low"};
test("managed child delivers result, isolates ownership and honors operator model override",async()=>{
 const h=new Harness({runtime:new FakeRuntime(()=>"evidence"),tickMs:60000});h.onStateChange=async()=>{};
 const manager=new Subagents(h,async()=>{});h.addChannel(manager.channel);
 try{
  manager.setOverride("parent",{model:"provider/large",thinking:"high"});
  const child=await manager.start("parent",handover);await h.drained();
  assert.equal(child.handover.model,"provider/large");assert.equal(child.handover.thinking,"high");
  assert.equal(manager.get("parent",child.id).result,"evidence");
  assert.equal(manager.get("parent",child.id).state,"completed");
  assert.throws(()=>manager.get("other",child.id),/Unknown/);
  await assert.rejects(manager.start(child.sessionKey,handover),/Nested/);
 }finally{await h.stop(1000);}
});
test("paused child can be cancelled without executing and survives serialized records",async()=>{
 let calls=0;const h=new Harness({runtime:new FakeRuntime(()=>{calls++;return "bad";}),tickMs:60000});h.paused=true;h.onStateChange=async()=>{};
 const manager=new Subagents(h,async()=>{});h.addChannel(manager.channel);
 try{
  const child=await manager.start("parent",handover);
  const restored=new Subagents(h,async()=>{});restored.restore(JSON.parse(JSON.stringify(manager.snapshot())));
  assert.equal(restored.get("parent",child.id).state,"queued");
  await manager.cancel("parent",child.id);h.resume();await h.drained();
  assert.equal(calls,0);assert.equal(manager.get("parent",child.id).state,"cancelled");
 }finally{await h.stop(1000);}
});
