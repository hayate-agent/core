import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { PiRuntime } from '../src/runtime/pi.js';
import { modelInputEstimate } from '../src/model-input-budget.js';

test('provider rejecting oversized continuation does not replay effect or lose its receipt', async () => {
 const home=await mkdtemp(path.join(os.tmpdir(),'provider-limit-'));
 const models=await ModelRuntime.create(); let calls=0,effects=0;
 models.registerProvider('effect-fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:[{
  id:'main',name:'Effect fixture',api:'openai-completions',reasoning:false,input:['text'],contextWindow:1000000,maxTokens:4096,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
 }],streamSimple:(model,context)=>{
  calls++;
  const reject=calls>1;
  if(reject) assert.ok(modelInputEstimate(context.messages)>131072);
  const message:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,
   content:reject?[]:[{type:'toolCall',id:'effect-once',name:'plugin_effect',arguments:{}}],
   usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
   stopReason:reject?'error':'toolUse',timestamp:Date.now(),...(reject?{errorMessage:'provider context limit'}:{})};
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{if(reject)stream.push({type:'error',reason:'error',error:message});else stream.push({type:'done',reason:'toolUse',message});stream.end();});return stream;
 }});
 const runtime=new PiRuntime({cwd:home,sessionsDir:path.join(home,'sessions'),skillPaths:[],model:'effect-fixture/main',
  compactionOwner:()=> 'harness',personaSections:async()=>['No replay of uncertain effects.'],
  approvals:{mode:'off',tools:[]},tools:['plugin_effect'],pluginTools:()=>[{name:'plugin_effect',description:'Receipt fixture',parameters:{type:'object',properties:{}},
   execute:async()=>{effects++;return 'receipt-uncertain '+ '界'.repeat(46000);}}]});
 (runtime as any).modelRuntime=async()=>models;
 try {
  const wrapped:any=await runtime.open('matrix:effect'); const id=wrapped.session.sessionId;
  try {
   await assert.rejects(wrapped.prompt('Perform the authorized fixture once; reconcile any uncertain receipt. Current task data: '+ '界'.repeat(46000)),/provider context limit/);
   assert.equal(effects,1);assert.ok(calls>=2, 'provider rejected the oversized continuation');
   const file=wrapped.session.sessionManager.getSessionFile();
   await wrapped.dispose();
   const persisted=await readFile(file,'utf8');
   assert.ok(persisted.includes('receipt-uncertain'));assert.ok(persisted.includes('effect-once'));
   const reopened:any=await runtime.open('matrix:effect');
   try {
    assert.equal(reopened.session.sessionId,id);
    assert.ok(reopened.session.sessionManager.getEntries().some((e:any)=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolCallId==='effect-once'));
    assert.equal(effects,1);
   }finally{await reopened.dispose();}
  }finally{await wrapped.dispose();}
 }finally{await rm(home,{recursive:true,force:true});}
});
