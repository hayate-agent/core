import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {git,captureChangeset} from '../src/changeset.js';

test('review capture preserves trailing spaces in repository root',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'changeset-root-'));
 try{
  for(const name of ['ordinary','trailing ','two  ']){
   const cwd=path.join(home,name);await mkdir(cwd);
   await git(cwd,['init']);await git(cwd,['config','user.name','Fixture']);await git(cwd,['config','user.email','fixture@example.invalid']);
   await writeFile(path.join(cwd,'base'),'before');await git(cwd,['add','.']);await git(cwd,['commit','-m','fixture']);
   await writeFile(path.join(cwd,'base'),'after');await writeFile(path.join(cwd,'new.txt'),'synthetic');
   const captured=await captureChangeset(cwd,'HEAD');
   assert.equal(captured.root,cwd);assert.deepEqual(captured.files,['base','new.txt']);
   assert.match(captured.diff,/after/);assert.match(captured.diff,/synthetic/);
  }
 }finally{await rm(home,{recursive:true,force:true});}
});
