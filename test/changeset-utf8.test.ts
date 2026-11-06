// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {git,captureChangeset} from '../src/changeset.js';

test('untracked invalid UTF8 is rejected rather than fingerprinting replacement characters',async(t)=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'changeset-utf8-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await git(dir,['init']);await git(dir,['config','user.name','Fixture']);await git(dir,['config','user.email','fixture@example.invalid']);
 await writeFile(path.join(dir,'base'),'base');await git(dir,['add','.']);await git(dir,['commit','-m','base']);
 for(const bytes of [[0x80],[0x81],[0xc3],[0xc0,0xaf]]){
  await writeFile(path.join(dir,'new.ts'),Buffer.from(bytes));
  await assert.rejects(captureChangeset(dir,'HEAD'),/invalid UTF-8/);
 }
 await writeFile(path.join(dir,'new.ts'),'Valid 😀 � Unicode');
 const first=await captureChangeset(dir,'HEAD');assert.match(first.diff,/Valid 😀 � Unicode/);
 await writeFile(path.join(dir,'new.ts'),'Other 😀 � Unicode');
 assert.notEqual((await captureChangeset(dir,'HEAD')).fingerprint,first.fingerprint);
});
