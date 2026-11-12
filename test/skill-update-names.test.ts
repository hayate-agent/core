import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillUpdates } from '../src/skill-updates.js';

test('skill bundle names follow catalog slug grammar before activation',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'skill-slugs-'));
 try{
  for(const name of ['a','good-name','a'.repeat(64),'bad-','bad--name','a'.repeat(65),'1bad','Bad']) {
   const bytes=Buffer.from(JSON.stringify({version:1,skills:[{name,content:`---\nname: ${name}\ndescription: fixture\n---\nBody`}]}));
   const update=new SkillUpdates(path.join(home,name),{url:'https://example.invalid/bundle',sha256:createHash('sha256').update(bytes).digest('hex')},(async()=>new Response(bytes)) as typeof fetch);
   let calls=0; const activate=async()=>{calls++;};
   if(['a','good-name','a'.repeat(64)].includes(name)) {await update.apply(activate);assert.equal(calls,1);}
   else {await assert.rejects(update.apply(activate),/Invalid skill entry/);assert.equal(calls,0);assert.deepEqual(update.roots,[]);}
  }
 }finally{await rm(home,{recursive:true,force:true});}
});
