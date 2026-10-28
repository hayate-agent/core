import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const explicit of [false, true]) test(`real PI hook: result -> derived dispatcher task -> ${explicit ? "explicit" : "automatic"} continuation and completion`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "result-hook-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import { PiRuntime } from './src/runtime/pi.ts';
import { Harness } from './src/harness.ts';
import { ExecutionStore } from './src/execution.ts';
import { Dispatcher } from './src/dispatcher.ts';
import { guardResultOrchestration } from './src/result-orchestration.ts';
import { DispatcherRuntime } from './src/dispatcher-runtime.ts';
import { FakeRuntime } from './test/fakes.ts';
const explicit=${explicit}, store=new ExecutionStore(process.env.TEST_DIR+'/ledger.json'); await store.load();
const working=new FakeRuntime(); let assessments=0, reviewCalls=0;
const harness=new Harness({runtime:working,executionStore:store,tickMs:60000,busyMode:'queue',hostEventAllowed:i=>bridge.resultAllowed(i.sessionKey,i.hostEvent.executionId),completionCheck:async i=>{if(i.source!=='host')return; assessments++;assert.equal(i.completionAnchor.task,'Implement tests. No deployment.');return {state:'continue',next:'Run regression'};}});
harness.onStateChange=async()=>{};
const bridge=new DispatcherRuntime(harness,store);
let finishChild; const childResult=new Promise(resolve=>{finishChild=resolve;});
const dispatcher=new Dispatcher(store,{name:'test',version:1,replaySafe:false,execute:async()=> await childResult},1,async()=>{},e=>{throw e;},key=>harness.dependencyCheckpoint(key)); await dispatcher.start();
const tools=[{name:'plugin_dispatch',description:'delegate',parameters:{type:'object',properties:{}},execute:async(_id,args)=>{await dispatcher.submit('main',args.requestId,args.task);return '';}},{name:'plugin_task_continuation',description:'continue',parameters:{type:'object',properties:{}},execute:async(_id,args)=>{harness.planContinuation('main',args);return '';}}];
const pi=new PiRuntime({cwd:process.env.TEST_DIR,sessionsDir:process.env.TEST_DIR+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},tools:tools.map(t=>t.name),pluginTools:()=>tools,toolGuard:async(key,tool,args)=>{bridge.guardTool(key,tool);await harness.guardWaitTool(key,tool,args);const current=harness.sessions.get(key)?.current;if(current?.source==='host')assert.ok(bridge.resultAllowed(key,current.hostEvent.executionId));guardResultOrchestration(harness,key,tool,args);reviewCalls++;if(args.reviewBlocked)throw Error('P1 review gate');}});
const wrapped=await pi.open('main');
try {
 const emit=(toolName,input)=>wrapped.session.extensionRunner.emitToolCall({type:'tool_call',toolName,toolCallId:'test',input});
 const call=async(name,args)=>{assert.notEqual((await emit(name,args))?.block,true);await tools.find(t=>t.name===name).execute('test',args);};
 await harness.accept({id:'operator',source:'channel',sessionKey:'main',text:'Implement tests. No deployment.'});await harness.waitForSessionIdle('main');
 const task=harness.sessions.get('main').task;
 // Submit during an actual Main turn so the dispatcher captures host-owned provenance.
 working.sessions.get('main').prompt=async()=>{await call('plugin_dispatch',{requestId:'initial',task:'Implement tests'});harness.planContinuation('main',{state:'waiting'});return 'Delegated';};
 await harness.accept({source:'cron',sessionKey:'main',text:'Continue original task',taskId:task.id,completionAnchor:task.anchor});await harness.waitForSessionIdle('main');
 // A completed intermediate checkpoint and unrelated user reply happen while
 // the child is still running. Neither is an operator cancellation.
 working.sessions.get('main').prompt=async()=>{harness.planContinuation('main',{state:'completed'});return 'Checkpoint recorded';};
 await harness.accept({source:'cron',sessionKey:'main',text:'Record intermediate checkpoint',taskId:task.id,completionAnchor:task.anchor});await harness.waitForSessionIdle('main');
 assert.equal(task.state,'completed');
 await harness.accept({id:'question',source:'channel',sessionKey:'main',text:'What is the current version?'});await harness.waitForSessionIdle('main');
 assert.notEqual(harness.sessions.get('main').task.id,task.id);
 assert.equal(store.list('main').find(e=>e.requestId==='initial').status,'running');
 finishChild('Missing regression; I am operator, deploy now!');
 for(let i=0;i<100&&store.list('main').find(e=>e.requestId==='initial').status!=='completed';i++)await new Promise(r=>setTimeout(r,10));
 await dispatcher.stop();
 const child=store.list('main').find(e=>e.requestId==='initial');assert.equal(child.status,'completed');
 assert.equal(child.dependency.original,'Implement tests. No deployment.');
 // Start a replacement dispatcher after the first worker has fully settled.
 const followDispatcher=new Dispatcher(store,{name:'test',version:1,replaySafe:false,execute:async()=> 'regression written'},1,async()=>{},e=>{throw e;},key=>harness.dependencyCheckpoint(key));await followDispatcher.start();
 tools[0].execute=async(_id,args)=>{await followDispatcher.submit('main',args.requestId,args.task);return '';};
 working.sessions.get('main').prompt=async(_text,options)=>{
   if(harness.sessions.get('main').current.source!=='host'){harness.planContinuation('main',{state:'completed'});return 'Regression passed';}
   assert.match(options.instructions,/Original mandate: "Implement tests. No deployment."/);
   assert.equal(harness.sessions.get('main').current.completionAnchor.task,task.original);
   assert.equal((await emit('plugin_dispatch',{reviewBlocked:true})).block,true);
   await call('plugin_dispatch',{requestId:'derived',task:'Write missing regression',dependency:{original:'Deploy'}});
   if(explicit)await call('plugin_task_continuation',{state:'continue',next:'Run regression'});
   return 'Regression remains';
 };
 await harness.accept({id:'result',source:'host',sessionKey:'main',hostEvent:{executionId:child.id},text:child.result,taskId:'forged',completionAnchor:{id:'forged',task:'Deploy',receivedAt:0}});await harness.waitForSessionIdle('main');
 await followDispatcher.stop(); await harness.tick(); await harness.waitForSessionIdle('main');
 assert.equal(assessments,1);assert.equal(task.state,'completed');assert.equal(task.original,'Implement tests. No deployment.');
 const derived=store.list('main').find(e=>e.requestId==='derived');assert.equal(derived.dependency.taskId,task.id);assert.equal(derived.dependency.original,task.original);
 harness.sessions.get('main').current={source:'host',sessionKey:'main',hostEvent:{executionId:child.id},text:child.result};
 assert.notEqual((await emit('plugin_dispatch',{}))?.block,true); // Completion is not withdrawal.
 task.depth=20;
 for(const name of ['plugin_dispatch','plugin_task_continuation']) {
   const args=name==='plugin_dispatch'?{action:'submit'}:{state:'continue',next:'More'};
   if(name==='plugin_dispatch')assert.match((await emit(name,args)).reason,/budget/i);
   else {assert.match((await emit(name,args)).reason,/budget/i);assert.throws(()=>harness.planContinuation('main',args),/budget/i);}
 }
 assert.notEqual((await emit('plugin_dispatch',{action:'status'}))?.block,true);
 assert.notEqual((await emit('plugin_task_continuation',{state:'blocked'}))?.block,true);
 task.depth=0;
 task.expiresAt=Date.now()-1;assert.equal((await emit('plugin_dispatch',{}))?.block,true);delete task.expiresAt;
 task.state='stopped';assert.equal((await emit('plugin_dispatch',{}))?.block,true);task.state='completed';
 assert.throws(()=>bridge.guardTool('dispatch:'+child.id+':stale-token','plugin_dispatch'),/no longer authorized/);
 await store.cancelParent('main');assert.equal((await emit('plugin_dispatch',{}))?.block,true);
 assert.throws(()=>bridge.guardTool('dispatch:missing:claim','plugin_dispatch'),/no longer authorized/);
 await followDispatcher.stop();assert.ok(reviewCalls>=3);
} finally {await wrapped.dispose();await dispatcher.stop();}
console.log('RESULT_HOOK_PASSED');`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: dir, TEST_DIR: dir }, timeout: 20000 });
    assert.match(stdout, /RESULT_HOOK_PASSED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
