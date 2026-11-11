import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Harness} from '../src/harness.js';import {ExecutionStore} from '../src/execution.js';import {Dispatcher} from '../src/dispatcher.js';import {Scheduler} from '../src/scheduler.js';
import {dispatcherPlugin} from '../src/builtin-plugins/dispatcher-plugin.js';import {FakeRuntime} from './fakes.js';
import type {InputSource} from '../src/types.js';

for(const source of ['loop','heartbeat','goal','cron','api']as InputSource[])test(`${source} new occurrences obtain distinct host-owned mandates and can delegate without model taskId`,async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'scheduled-mandate-'));const store=new ExecutionStore(path.join(dir,'executions.json'));await store.load();
 const runtime=new FakeRuntime();const h=new Harness({runtime,executionStore:store,completionCheck:async()=>({state:'completed'})});h.onStateChange=async()=>{};
 h.restoreSessions([{key:'main',tasks:[{id:'old',original:'old task',state:'blocked',depth:0,expiresAt:1,recoveryEnrollment:'held-legacy'}],task:{id:'old',original:'old task',state:'blocked',depth:0,expiresAt:1,recoveryEnrollment:'held-legacy'}}]);
 const d=new Dispatcher(store,{name:'direct',version:1,replaySafe:true,execute:async()=> 'read-only evidence'},1,async()=>{},()=>{},key=>h.dependencyCheckpoint(key));await d.start();
 t.after(async()=>{await d.stop();await h.stop(0);await rm(dir,{recursive:true,force:true});});let tool:any;dispatcherPlugin(()=>d).activate({registerTool:(v:any)=>tool=v,registerCommand:()=>{}}as any);
 const receipts:any[]=[];runtime.answer=async(text,key)=>{
  const mandate=h.dependencyCheckpoint(key);assert.ok(mandate?.taskId);assert.equal(mandate.original,text);assert.equal(mandate.expiresAt,undefined);
  receipts.push(JSON.parse(await tool.execute({action:'submit',requestId:`request-${receipts.length}`,task:'collect current overview'},{sessionKey:key})));
  await assert.rejects(tool.execute({action:'submit',requestId:'wrong',task:'wrong scope',taskId:'old'},{sessionKey:key}),/execution-context-mismatch/);
  return 'delegated';
 };
 for(let i=0;i<2;i++){h.enqueue({sessionKey:'main',source,text:`fresh ${source} occurrence ${i}`});await h.waitForSessionIdle('main');}
 assert.equal(receipts.length,2);assert.notEqual(receipts[0].mandate.taskId,receipts[1].mandate.taskId);assert.ok(receipts.every(r=>r.mandate.taskId!=='old'));
 assert.equal(h.snapshotSessions()[0]!.tasks!.find(t=>t.id==='old')!.recoveryEnrollment,'held-legacy');
});

test('real Scheduler prompt job supplies a mandate at tool execution, isolated from report follow-up permission',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cron-mandate-'));const store=new ExecutionStore(path.join(dir,'executions.json'));await store.load();
 const runtime=new FakeRuntime();const h=new Harness({runtime,executionStore:store,completionCheck:async()=>({state:'completed'})});h.onStateChange=async()=>{};
 const d=new Dispatcher(store,{name:'direct',version:1,replaySafe:true,execute:async()=> 'evidence'},1,async()=>{},()=>{},key=>h.dependencyCheckpoint(key));await d.start();
 t.after(async()=>{await d.stop();await h.stop(0);await rm(dir,{recursive:true,force:true});});
 runtime.answer=async(text,key)=>{const job=await d.submitCurrent(key,'cron-query','query read-only sources');assert.equal(job.dependency?.original,text);return 'submitted';};
 const scheduler=new Scheduler(h,{timezone:'UTC'});await scheduler.runJob({name:'overview',schedule:'0 * * * *',prompt:'Query current overview',deliver:'local'});await h.waitForSessionIdle('cron:overview');
 assert.equal(store.list().length,1);assert.ok(store.list()[0]!.dependency?.taskId);
});

test('held historical task cannot supply a current mandate',async t=>{
 const h=new Harness({runtime:new FakeRuntime()});t.after(()=>h.stop(0));h.restoreSessions([{key:'main',tasks:[{id:'held',original:'old',state:'blocked',depth:0,recoveryEnrollment:'held-legacy'}]}]);h.state('main').current={sessionKey:'main',source:'cron',taskId:'held',text:'old'};
 assert.equal(h.dependencyCheckpoint('main'),undefined);
});

test('host binding without a live task fails closed',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'empty-mandate-'));const s=new ExecutionStore(path.join(dir,'executions.json'));await s.load();const d=new Dispatcher(s,{name:'direct',version:1,replaySafe:true,execute:async()=> 'x'},1,async()=>{});
 t.after(async()=>{await d.stop();await rm(dir,{recursive:true,force:true});});await d.start();await assert.rejects(d.submitCurrent('main','request','task'),/parent-mandate-missing/);assert.equal(s.list().length,0);
});
