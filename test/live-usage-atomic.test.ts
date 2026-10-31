import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RunRegistry} from '../src/api/runs.js';
for(const field of ['input','output','cacheRead','cacheWrite'])for(const value of [-1,0.5,NaN,Infinity,'2'])test(`ignore invalid ${field}=${value}`,async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'live-usage-'));t.after(()=>rm(home,{recursive:true,force:true}));const reg=new RunRegistry(path.join(home,'runs.json'));const r=reg.create({session_key:'test'});
 reg.turnEvent(r.run_id,{type:'usage',input:1,output:2,cacheRead:3,cacheWrite:4,costUsd:0.1});const before=structuredClone(r);const seen:unknown[]=[];const sub=reg.subscribe(r.run_id,-1,e=>seen.push(e));
 reg.turnEvent(r.run_id,{type:'usage',input:1,output:1,cacheRead:1,cacheWrite:1,model:'changed/model',costUsd:3,[field]:value} as any);
 sub.unsubscribe();assert.deepEqual(r,before);assert.equal(seen.length,0);
});
test('overflow ignored atomically and valid zero/addition events retained',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'live-usage-'));t.after(()=>rm(home,{recursive:true,force:true}));const reg=new RunRegistry(path.join(home,'runs.json'));const r=reg.create({session_key:'test'});
 reg.turnEvent(r.run_id,{type:'usage',input:Number.MAX_SAFE_INTEGER,output:0,cacheRead:0,cacheWrite:0,costUsd:0});const before=structuredClone(r);
 reg.turnEvent(r.run_id,{type:'usage',input:1,output:7,cacheRead:0,cacheWrite:0,costUsd:0});assert.deepEqual(r,before);
 reg.turnEvent(r.run_id,{type:'usage',input:0,output:2,cacheRead:1,cacheWrite:0,costUsd:0});assert.equal(r.usage!.output_tokens,2);assert.equal(r.usage!.input_tokens,Number.MAX_SAFE_INTEGER);
 reg.turnEvent(r.run_id,{type:'text',delta:'still running'});await reg.finish(r.run_id,'done');assert.equal(r.output,'done');
});
