import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { PiRuntime } from '../src/runtime/pi.js';
import { modelInputAdmission, modelInputEstimate, modelInputLimit } from '../src/model-input-budget.js';

test('admission counts complete UTF-8 system/tools/history without mutating or splitting tool pairs', () => {
 const messages = [
  {role:'system',content:'Never repeat uncertain effects',toolsAdded:[{name:'effect',parameters:{type:'object',description:'日本語'.repeat(100)}}]},
  {role:'user',content:'Preserve mandate and pending task'},
  {role:'assistant',content:[{type:'toolCall',id:'effect-1',name:'effect',arguments:{text:'ä'.repeat(100)}}]},
  {role:'toolResult',toolCallId:'effect-1',content:[{type:'text',text:'Effect receipt: uncertain; reconcile first'}]},
 ];
 const original=structuredClone(messages);
 const estimate=modelInputEstimate(messages);
 assert.ok(estimate>JSON.stringify(messages).length);
 assert.deepEqual(modelInputAdmission(messages,estimate),{estimate,limit:estimate,admitted:true});
 assert.equal(modelInputAdmission(messages,estimate-1).admitted,false);
 assert.deepEqual(messages,original);
 assert.equal(modelInputLimit(500000,1000000,4096),131072);
 assert.equal(modelInputLimit(131072,32000,4096),27904);
 assert.equal(modelInputLimit(8192,0,4096),8192);
 assert.equal(modelInputLimit(8192,1000,4096),0);
 for (const invalid of [NaN, Infinity, -1, 0, 131072.5]) assert.throws(()=>modelInputLimit(invalid,1000000,4096));
 for (const invalid of [NaN, Infinity, -1, 1.5]) {
  assert.throws(()=>modelInputLimit(131072,32000,invalid));
  assert.throws(()=>modelInputAdmission(messages,invalid));
 }
});

test('actual final provider projection is admitted or fails closed, including tools, recall and ephemeral requests', async () => {
 const home=await mkdtemp(path.join(os.tmpdir(),'input-admission-'));
 const models=await ModelRuntime.create(); const sent: any[]=[];
 models.registerProvider('input-fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:[{
  id:'main',name:'Input fixture',api:'openai-completions',reasoning:false,input:['text'],contextWindow:1000000,maxTokens:4096,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
 }],streamSimple:(model,context)=>{
  sent.push(structuredClone(context));
  const message:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'DONE'}],
   usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message});stream.end();});return stream;
 }});
 try {
  for(const kind of ['normal','oversized-user','oversized-system','oversized-tool','ephemeral'] as const){
   const runtime=new PiRuntime({cwd:home,sessionsDir:path.join(home,kind),skillPaths:[],model:'input-fixture/main',
    personaSections:async()=>kind==='oversized-system'?['MANDATE '+ 'x'.repeat(140000)]:['Do not repeat uncertain effects.'],
    recallStep:async()=> 'unfinished effect: reconcile receipt; do not replay',approvals:{mode:'off',tools:[]},
    tools:kind==='oversized-tool'?['plugin_fixture']:[],
    pluginTools:()=>kind==='oversized-tool'?[{name:'plugin_fixture',description:'x'.repeat(140000),parameters:{type:'object',properties:{}},execute:async()=>''}]:[],
   });
   (runtime as any).modelRuntime=async()=>models;
   const wrapped:any=await runtime.open(kind==='ephemeral'?'assessment:admission':'matrix:'+kind,{ephemeral:kind==='ephemeral'});
   const id=wrapped.session.sessionId; const before=sent.length;
   const text=kind==='normal'?'authorized fixture': 'preserve authority '+ 'x'.repeat(kind==='oversized-tool'||kind==='oversized-system'?1:140000);
   try {
    if(kind==='normal'){
     assert.equal(await wrapped.prompt(text),'DONE');assert.equal(sent.length,before+1);
     assert.ok(modelInputEstimate(sent.at(-1).messages)<=131072);
     assert.match(JSON.stringify(sent.at(-1)),/unfinished effect: reconcile receipt/);
    }else{
     await assert.rejects(wrapped.prompt(text),/Model input budget exceeded/);
     assert.equal(sent.length,before,'no summary or working provider call for oversized input');
     assert.ok(wrapped.session.messages.some((m:any)=>m.role==='user'&&(typeof m.content==='string'?m.content:m.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''))===text),'input retained in native history');
    }
    assert.equal(wrapped.session.sessionId,id,'session identity unchanged');
   }finally{await wrapped.dispose();}
  }
 }finally{await rm(home,{recursive:true,force:true});}
});

test('oversized settled tool evidence blocks working AND compaction calls without replay; raw pairs survive reopen', async () => {
 const home=await mkdtemp(path.join(os.tmpdir(),'input-effect-'));
 const models=await ModelRuntime.create(); let calls=0,working=0,effects=0;
 models.registerProvider('effect-fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:[{
  id:'main',name:'Effect fixture',api:'openai-completions',reasoning:false,input:['text'],contextWindow:1000000,maxTokens:4096,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
 }],streamSimple:(model,context)=>{
  calls++;
  assert.ok(modelInputEstimate(context.messages)<=131072,'no oversized working or summary request reaches provider');
  const summary=context.messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.startsWith('You are a context summarization assistant.'));
  if(!summary) { working++;assert.equal(working,1,'no oversized working continuation reaches provider'); }
  const message:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,
   content:summary?[{type:'text',text:'Keep the original mandate and uncertain effect receipt; do not replay.'}]:[{type:'toolCall',id:'effect-once',name:'plugin_effect',arguments:{}}],
   usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:summary?'stop':'toolUse',timestamp:Date.now()};
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;
 }});
 const runtime=new PiRuntime({cwd:home,sessionsDir:path.join(home,'sessions'),skillPaths:[],model:'effect-fixture/main',
  compactionOwner:()=> 'harness',contextBudgets:()=>({mainContextTokens:8192,workerContextTokens:8192}),personaSections:async()=>['No replay of uncertain effects.'],
  approvals:{mode:'off',tools:[]},tools:['plugin_effect'],pluginTools:()=>[{name:'plugin_effect',description:'Receipt fixture',parameters:{type:'object',properties:{}},
   execute:async()=>{effects++;return 'receipt-uncertain '+ '界'.repeat(46000);}}]});
 (runtime as any).modelRuntime=async()=>models;
 try {
  const wrapped:any=await runtime.open('matrix:effect'); const id=wrapped.session.sessionId;
  try {
   await assert.rejects(wrapped.prompt('Perform the authorized fixture once; reconcile any uncertain receipt.'),/Model input budget exceeded/);
   assert.equal(working,1,'oversized working projection was blocked after the one tool effect');
   const beforeSummary=calls;
   // Automatic pressure maintenance may have just appended a compaction entry.
   // Add finalized history through the public SDK API, without triggering a
   // model turn or repeating the effect. Two spans exceed keepRecentTokens so
   // native prepareCompaction has a real new prefix to summarize.
   for (const label of ['new evidence', 'retained tail']) await wrapped.session.sendCustomMessage({
    customType:'fixture-evidence',content:`${label}: receipt-uncertain; reconcile, never replay. `+'e'.repeat(36000),display:false,
   },{triggerTurn:false});
   const beforeEntries=structuredClone(wrapped.session.sessionManager.getEntries());
   // A summary can legitimately exclude a large recent pair. Make its own
   // instructions oversized and observe the REAL shared admission gate, rather
   // than accepting an earlier SDK preparation failure as equivalent evidence.
   const preserve='Keep authority and unfinished effects; never replay. '+ 'x'.repeat(140000);
   const admissionGate=wrapped.session.agent.streamFunction; let summaryAttempts=0;
   wrapped.session.agent.streamFunction=(model:any,context:any,options:any)=>{
    summaryAttempts++;
    assert.match(JSON.stringify(context.messages),/Keep authority and unfinished effects; never replay/);
    assert.equal(modelInputAdmission(context.messages,modelInputLimit(131072,model.contextWindow,options?.maxTokens??model.maxTokens)).admitted,false);
    return admissionGate(model,context,options);
   };
   await assert.rejects(wrapped.session.compact(preserve),/Model input budget exceeded/);
   // Harness maintenance intentionally sanitizes raw diagnostics; the second
   // observed gate attempt proves this isn't hiding another Already compacted.
   await assert.rejects(wrapped.compact(preserve),/Context maintenance compact: failed/);
   assert.equal(summaryAttempts,2,'native and harness summary requests both reached admission');
   assert.deepEqual(wrapped.session.sessionManager.getEntries(),beforeEntries,'failed summaries preserve every original entry and effect pair');
   assert.equal(effects,1);assert.equal(calls,beforeSummary,'oversized explicit summaries never reach provider');
   const entries=wrapped.session.sessionManager.getEntries();
   assert.ok(entries.some((e:any)=>e.type==='message'&&e.message.role==='assistant'&&e.message.content.some((p:any)=>p.type==='toolCall'&&p.id==='effect-once')));
   assert.ok(entries.some((e:any)=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolCallId==='effect-once'));
   assert.equal(wrapped.session.sessionId,id);
   const file=wrapped.session.sessionManager.getSessionFile();
   await wrapped.dispose();
   const persisted=await readFile(file,'utf8');
   assert.match(persisted,/receipt-uncertain/);assert.match(persisted,/effect-once/);
   const reopened:any=await runtime.open('matrix:effect');
   try {
    assert.equal(reopened.session.sessionId,id);
    assert.ok(reopened.session.sessionManager.getEntries().some((e:any)=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolCallId==='effect-once'));
    assert.equal(effects,1,'opening retained history never repeats the tool');
   } finally {await reopened.dispose();}
  } finally {await wrapped.dispose();}
 } finally {await rm(home,{recursive:true,force:true});}
});
