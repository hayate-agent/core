import test from 'node:test';
import assert from 'node:assert/strict';
import {Harness} from '../src/harness.js';
import {FakeRuntime,MemoryChannel,msg} from './fakes.js';
import {assessCompletion} from '../src/completion-check.js';
import {completionPrompt} from '../src/builtin-plugins/completion-prompt.js';
import {ExecutionStore} from '../src/execution.js';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const key='mem:room1', original='Implement ORIGINAL_SENTINEL and verify acceptance', next='Read SAVED_NEXT_SENTINEL independent acceptance results', reply='PRIOR_RESULT_SENTINEL: prior child effect finished';
const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function setup(opts:ConstructorParameters<typeof Harness>[0]) {
 const h=new Harness({...opts,tickMs:600000}); h.addChannel(new MemoryChannel());h.onStateChange=async()=>{};return h;
}
for(const restart of [true,false]) test(`technical continue recovers with real prompt, exactly once (restart=${restart})`,async()=>{
 let now=1000,healthy=false,checks=0,effects=0,prompt='';
 let h:Harness;
 const check:NonNullable<ConstructorParameters<typeof Harness>[0]['completionCheck']>=async(input,result,signal,diagnostic)=>{
  checks++;
  if(!healthy) throw Error('SECRET_PROVIDER_TOKEN');
  if(effects) return {state:'completed'};
  return assessCompletion({review:async p=>{prompt=p;return JSON.stringify({state:'continue',next});}},input,result,{task:input.completionAnchor!.task},signal,undefined,()=>now,completionPrompt,diagnostic);
 };
 let first=true;
 const worker=new FakeRuntime(()=>{if(!first){effects++;return 'Acceptance verified';}first=false;h.planContinuation(key,{state:'continue',next});return reply;});
 h=setup({runtime:worker,now:()=>now,completionCheck:check});
 try {
  await h.submit(msg(original));await h.drained();
  const saved=json(h.snapshotSessions()),t=saved[0].tasks![0];
  assert.equal(t.state,'active');assert.equal(t.explicitBlocked,false);assert.equal(t.next,next);
  assert.equal(t.supervisorDecision?.verdict,'unresolved');assert.equal(t.recoveryRetry?.attempts,1);
  assert.equal(h.pendingInputs().length,0);
  if(restart){await h.stop(0);h=setup({runtime:new FakeRuntime(()=>{effects++;return 'Acceptance verified';}),now:()=>now,completionCheck:check});h.restoreSessions(saved);}
  healthy=true;await h.tick();assert.equal(checks,1);assert.equal(effects,0);
  now+=60001;await h.tick();
  for(const evidence of ['ORIGINAL_SENTINEL','SAVED_NEXT_SENTINEL','PRIOR_RESULT_SENTINEL','technical','attempts'])assert.match(prompt,new RegExp(evidence));
  const data=JSON.parse(prompt.split('\nDATA: ')[1]);
  assert.equal(data.context.retained.technical.retryDiagnostic,'technical');
  assert.equal(data.context.retained.technical.attempts,2);
  assert.doesNotMatch(prompt,/SECRET_PROVIDER_TOKEN/);
  h.releaseRestored();await h.drained();
  assert.equal(effects,1);assert.equal(worker.sessions.get(key)?.prompts.filter(p=>p===original).length,1);
  const finished=json(h.snapshotSessions());await h.stop(0);
  h=setup({runtime:new FakeRuntime(()=>{effects++;return 'must not run';}),now:()=>now,completionCheck:check});h.restoreSessions(finished);await h.recoverTasks();await h.tick();h.releaseRestored();await h.drained();assert.equal(effects,1);
 }finally{await h.stop(0);}
});

test('technical retry budget and backoff survive repeated JSON restores and exhaust distinctly',async()=>{
 let now=1000,checks=0;let h:Harness;
 const make=()=>setup({runtime:new FakeRuntime(),now:()=>now,completionCheck:async()=>{checks++;throw Error('SECRET');}});
 h=make();h.restoreSessions([{key,tasks:[{id:'p',original,state:'active',next,depth:0,lastReply:reply}]}]);
 try{
  for(let attempt=1;attempt<=3;attempt++){
   await h.recoverTasks();assert.equal(checks,attempt);assert.equal(h.state(key).tasks![0].recoveryRetry?.attempts,attempt);
   const saved=json(h.snapshotSessions());await h.stop(0);h=make();h.restoreSessions(saved);
   await h.tick();assert.equal(checks,attempt);now+=60001;
  }
  await h.tick();await h.recoverTasks();assert.equal(checks,3);
  const t=h.state(key).tasks![0];assert.equal(t.state,'blocked');assert.notEqual(t.explicitBlocked,true);assert.equal(t.termination,undefined);assert.equal(t.recoveryRetry?.diagnostic,'technical');assert.equal(t.next,next);assert.equal(t.recoveryRetry?.attempts,3);assert.equal(h.pendingInputs().length,0);
 }finally{await h.stop(0);}
});

for(const hold of ['blocked','stop','expiry','pause'] as const)test(`hold during recovered assessment fences admission: ${hold}`,async()=>{
 let now=1000;let h:Harness;
 h=setup({runtime:new FakeRuntime(),now:()=>now,completionCheck:async()=>{
  if(hold==='stop')await h.stopConversation(key);
  else if(hold==='expiry')now=3000;
  else if(hold==='blocked'){h.state(key).tasks![0].state='blocked';h.state(key).tasks![0].explicitBlocked=true;}
  else h.paused=true; // global policy hold must not be bypassed
  return {state:'continue',next};
 }});
 h.restoreSessions([{key,tasks:[{id:'p',original,state:'active',next,depth:0,expiresAt:2000}]}]);
 try{await h.recoverTasks();assert.equal(h.pendingInputs().length,0);assert.equal(h.state(key).tasks![0].recoveryAdmission,undefined);}finally{await h.stop(0);}
});

test('new real approval question during technical assessment prevents admission',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'technical-approval-'));
 const store=new ExecutionStore(path.join(home,'executions.json'));await store.load();
 let childId='';
 const h=setup({runtime:new FakeRuntime(),executionStore:store,completionCheck:async()=>{
  const child=await store.submit(key,'approval','Request approval','direct',1,{taskId:'p',depth:0,original});childId=child.id;
  const claimed=await store.claim(child.id);await store.ask(child.id,claimed.token!,'Approve protected action?');
  return {state:'continue',next};
 }});
 h.restoreSessions([{key,tasks:[{id:'p',original,state:'active',next,depth:0}]}]);
 try{await h.recoverTasks();await h.tick();assert.equal(h.pendingInputs().length,0);assert.equal(h.state(key).tasks![0].recoveryAdmission,undefined);assert.equal(store.list().find(e=>e.id===childId)?.question?.answer,undefined);assert.equal(store.list().find(e=>e.id===childId)?.status,'paused');}
 finally{await h.stop(0);await rm(home,{recursive:true,force:true});}
});

test('independent semantic blocked verdict is not retried',async()=>{
 let checks=0;const h=setup({runtime:new FakeRuntime(),completionCheck:async()=>{checks++;return {state:'blocked'};}});
 h.restoreSessions([{key,tasks:[{id:'p',original,state:'active',next,depth:0}]}]);
 try{await h.recoverTasks();await h.tick();await h.recoverTasks();assert.equal(checks,1);assert.equal(h.state(key).tasks![0].state,'blocked');assert.equal(h.pendingInputs().length,0);}finally{await h.stop(0);}
});
