// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RunRegistry} from '../src/api/runs.js';
for(const costUsd of [-1,NaN,Infinity,'2',null,undefined])test(`ignore invalid cost ${costUsd}`,async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'live-cost-'));t.after(()=>rm(home,{recursive:true,force:true}));const reg=new RunRegistry(path.join(home,'runs.json'));const r=reg.create({session_key:'test'});
 reg.turnEvent(r.run_id,{type:'usage',input:1,output:2,cacheRead:3,cacheWrite:4,costUsd:0.1});const before=structuredClone(r);const seen:unknown[]=[];const sub=reg.subscribe(r.run_id,-1,e=>seen.push(e));
 reg.turnEvent(r.run_id,{type:'usage',input:1,output:1,cacheRead:1,cacheWrite:1,costUsd,model:'changed/model'} as any);
 sub.unsubscribe();assert.deepEqual(r,before);assert.equal(seen.length,0);
});
test('overflow ignored atomically; valid zero/fraction costs retained',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'live-cost-'));t.after(()=>rm(home,{recursive:true,force:true}));const reg=new RunRegistry(path.join(home,'runs.json'));const r=reg.create({session_key:'test'});
 reg.turnEvent(r.run_id,{type:'usage',input:1,output:0,cacheRead:0,cacheWrite:0,costUsd:Number.MAX_VALUE});const before=structuredClone(r);
 reg.turnEvent(r.run_id,{type:'usage',input:1,output:7,cacheRead:0,cacheWrite:0,costUsd:Number.MAX_VALUE});assert.deepEqual(r,before);
 const other=reg.create({session_key:'other'});for(const costUsd of [0,0.125,0.125])reg.turnEvent(other.run_id,{type:'usage',input:1,output:0,cacheRead:0,cacheWrite:0,costUsd});
 assert.equal(other.cost_usd,0.25);assert.equal(other.usage!.input_tokens,3);
});
