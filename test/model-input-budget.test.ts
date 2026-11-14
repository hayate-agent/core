import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { PiRuntime } from '../src/runtime/pi.js';
import { modelInputEstimate } from '../src/model-input-budget.js';

test('large byte estimates do not block provider requests or drop authority', async () => {
 const home=await mkdtemp(path.join(os.tmpdir(),'input-estimate-'));
 const models=await ModelRuntime.create(); const sent: any[]=[];
 models.registerProvider('input-fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:[{
  id:'main',name:'Input fixture',api:'openai-completions',reasoning:false,input:['text'],contextWindow:1000000,maxTokens:4096,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
 }],streamSimple:(model,context)=>{
  sent.push(structuredClone(context));
  const message:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'DONE'}],
   usage:{input:40000,output:1,cacheRead:0,cacheWrite:0,totalTokens:40001,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message});stream.end();});return stream;
 }});
 try {
  for(const kind of ['user','system','tool','ephemeral'] as const){
   const runtime=new PiRuntime({cwd:home,sessionsDir:path.join(home,kind),skillPaths:[],model:'input-fixture/main',
    personaSections:async()=>kind==='system'?['MANDATE '+ 'x'.repeat(140000)]:['Do not repeat uncertain effects.'],
    recallStep:async()=> 'unfinished effect: reconcile receipt; do not replay',approvals:{mode:'off',tools:[]},
    tools:kind==='tool'?['plugin_fixture']:[],
    pluginTools:()=>kind==='tool'?[{name:'plugin_fixture',description:'x'.repeat(140000),parameters:{type:'object',properties:{}},execute:async()=>''}]:[],
   });
   (runtime as any).modelRuntime=async()=>models;
   const wrapped:any=await runtime.open(kind==='ephemeral'?'assessment:fixture':'matrix:'+kind,{ephemeral:kind==='ephemeral'});
   const id=wrapped.session.sessionId; const before=sent.length;
   const text='preserve authority '+ 'x'.repeat(kind==='tool'||kind==='system'?1:140000);
   try {
    assert.equal(await wrapped.prompt(text),'DONE'); assert.equal(sent.length,before+1);
    assert.ok(modelInputEstimate(sent.at(-1).messages)>131072);
    if(kind!=='ephemeral') assert.ok(JSON.stringify(sent.at(-1)).includes('unfinished effect: reconcile receipt'));
    assert.equal(wrapped.session.sessionId,id);
   }finally{await wrapped.dispose();}
  }
 }finally{await rm(home,{recursive:true,force:true});}
});
