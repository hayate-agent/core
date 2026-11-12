import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os'; import path from 'node:path';
import { SessionArchives } from '../src/session-archive.js';

test('malformed archived entries fail closed before completion projection',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'archive-shape-'));
 try{
  const store=new SessionArchives(home);
  const archive=await store.create('room','old','summary','forward',[{id:'e',role:'user',text:'legacy'}]);
  await store.link('room',archive.id,'next');
  assert.equal((await store.completionEvidence('room','next')).status,'available');
  const file=path.join(home,'session-archives',createHash('sha256').update('room').digest('hex'),`${archive.id}.json`);
  for(const entry of [null,[],{id:'e',role:'user'},{id:5,role:'user',text:'x'},{id:'e',role:5,text:'x'},{id:'e',role:'user',text:'x',truncated:'false'}]){
   await writeFile(file,JSON.stringify({...archive,targetSessionId:'next',entries:[entry]}));
   await assert.rejects(store.load('room',archive.id),/Invalid session archive/);
   const evidence=await store.completionEvidence('room','next');
   assert.equal(evidence.status,'failed');assert.equal(evidence.incomplete,true);assert.deepEqual(evidence.entries,[]);
  }
 }finally{await rm(home,{recursive:true,force:true});}
});
