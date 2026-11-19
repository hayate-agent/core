import assert from 'node:assert/strict';import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {SessionArchives} from '../src/session-archive.js';

test('archive search retains mixed-case matching and pagination after query normalization',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'archive-query-'));
 try{
  const store=new SessionArchives(home);
  const archive=await store.create('room','old','summary','forward',Array.from({length:10},(_,i)=>({id:`e${i}`,role:'user',text:i%2?'nothing':'contains MIXED-NEEDLE here'})));
  const found=JSON.parse(await store.read('room',archive.id,{query:'MiXeD-Needle',offset:1,limit:2}));
  assert.equal(found.total,5);assert.deepEqual(found.entries.map((e:any)=>e.id),['e2','e4']);
  assert.equal(JSON.parse(await store.read('room',archive.id,{query:''})).total,10);
  assert.equal(JSON.parse(await store.read('room',archive.id,{query:'absent'})).total,0);
 }finally{await rm(home,{recursive:true,force:true});}
});
