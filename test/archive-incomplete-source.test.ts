import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionArchives } from '../src/session-archive.js';

test('completion evidence preserves aggregate incompleteness from linked source entries only', async () => {
 const home=await mkdtemp(path.join(os.tmpdir(),'archive-source-'));
 try {
  const store=new SessionArchives(home);
  for(const truncated of [true,false]) {
   const archive=await store.create('room','old','summary','forward',[{id:'e',role:'assistant',text:'synthetic excerpt',truncated}]);
   await store.link('room',archive.id,`next-${truncated}`);
  }
  for(const truncated of [true,false]) {
   const evidence=await new SessionArchives(home).completionEvidence('room',`next-${truncated}`);
   assert.equal(evidence.incomplete,truncated);
   assert.equal(evidence.status,truncated?'failed':'available');
   assert.equal(evidence.entries.find(e=>e.id.endsWith(':e'))?.truncated,truncated);
  }
  assert.equal((await store.completionEvidence('room','unrelated')).status,'empty');
 } finally { await rm(home,{recursive:true,force:true}); }
});
