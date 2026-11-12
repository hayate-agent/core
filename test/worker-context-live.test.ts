import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { PiRuntime } from '../src/runtime/pi.js';

test('native compaction actually occurs within one worker tool loop, preserving tool effects', async () => {
  const home=await mkdtemp(path.join(os.tmpdir(),'worker-inner-compact-'));
  const models=await ModelRuntime.create();
  let working=0,summaries=0,effects=0;
  models.registerProvider('bounded-fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline-fixture',models:[{
    id:'worker',name:'Worker fixture',api:'openai-completions',reasoning:false,input:['text'],contextWindow:200000,maxTokens:4096,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
  }],streamSimple:(model,context)=>{
    const summary=context.messages.some(m=>m.role==='system' && typeof m.content==='string' && m.content.startsWith('You are a context summarization assistant.'));
    if(summary)summaries++;else working++;
    const tool=!summary&&working<=3;
    const message:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,
      content:tool?[{type:'toolCall',id:'call-'+working,name:'plugin_evidence',arguments:{}}]:[{type:'text',text:summary?'Goal: authorized bounded fixture. Preserve performed effects; do not repeat them. Next: finish.':'DONE'}],
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:tool?'toolUse':'stop',timestamp:Date.now()};
    const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;
  }});
  const runtime=new PiRuntime({cwd:home,sessionsDir:path.join(home,'sessions'),skillPaths:[],model:'bounded-fixture/worker',
    compactionOwner:()=> 'harness',workerContextTokens:()=>8192,personaSections:async()=>[],approvals:{mode:'off',tools:[]},tools:['plugin_evidence'],
    pluginTools:()=>[{name:'plugin_evidence',description:'Return bounded evidence fixture',parameters:{type:'object',properties:{}},execute:async()=>{effects++;return ('evidence '+effects+'\n').repeat(3000);}}]});
  (runtime as any).modelRuntime=async()=>models;
  try {
    const wrapped:any=await runtime.open('dispatch:fixture:claim');
    const answer=await wrapped.prompt('Perform the authorized bounded fixture, then return DONE.');
    assert.equal(answer,'DONE');assert.equal(effects,3,'no replay of tool effects');assert.equal(working,4);
    assert.ok(summaries>0,'summary model invoked before outer prompt finishes');
    assert.ok(wrapped.session.sessionManager.getEntries().some((e:any)=>e.type==='compaction'),'durable native compaction entry');
    await wrapped.dispose();
  } finally {await rm(home,{recursive:true,force:true});}
});
