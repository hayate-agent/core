import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiRuntime } from '../src/runtime/pi.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { contextPolicy } from '../src/context-maintenance.js';

test('frontier main256Ki/children128Ki; explicit local main16Ki/children8Ki without inventing model windows', async () => {
 const home=await mkdtemp(path.join(os.tmpdir(),'context-budgets-'));
 const models=await ModelRuntime.create();
 models.registerProvider('budget-fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:['frontier','local'].map(id=>({id,name:id,api:'openai-completions',reasoning:false,input:['text'],contextWindow:1000000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))});
 try {
  for(const id of ['frontier','local']) {
   const runtime=new PiRuntime({cwd:home,sessionsDir:path.join(home,id),skillPaths:[],model:'budget-fixture/'+id,personaSections:async()=>[],compactionOwner:()=> 'agent',contextBudgets:()=>contextPolicy({localModels:['budget-fixture/local']}),approvals:{mode:'off',tools:[]}});
   (runtime as any).modelRuntime=async()=>models;
   for(const [key,ephemeral]of [['matrix:main',false],['dispatch:worker:claim',false],['subagent:worker',false],['assessment:validator',true],['cron:status',false],['api:cron-migrated-status',false]]as const){
    const wrapped:any=await runtime.open(key,{ephemeral});const session=wrapped.session;
    session.prompt=async()=>{const s=session.settingsManager.getCompactionSettings(session.model);const expected=id==='local'?(key==='matrix:main'?16384:8192):(key==='matrix:main'?262144:131072);assert.equal(session.model.contextWindow,1000000);assert.equal(session.model.contextWindow-s.reserveTokens,expected,`${id}/${key}`);assert.equal(s.enabled,true);};session.waitForIdle=async()=>{};
    await wrapped.prompt('read-only fixture');await wrapped.dispose();
   }
  }
 }finally{await rm(home,{recursive:true,force:true});}
});

test('context policy validates explicit local inventory and main budget',()=>{
 assert.equal(contextPolicy().workerContextTokens,131072);assert.equal(contextPolicy().mainContextTokens,262144);
 assert.throws(()=>contextPolicy({mainContextTokens:0}));assert.throws(()=>contextPolicy({localModels:['unqualified']}));
});
