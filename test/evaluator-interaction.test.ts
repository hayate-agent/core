import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ExperimentEvaluator} from '../src/improvement-experiments.js';
const exec=promisify(execFile);
test('timeout with failed cleanup persists recovery evidence', {skip:process.platform!=='linux'},async()=>{
 const root=await mkdtemp('/tmp/snape-interaction-');const oldPath=process.env.PATH;
 const git=async(...args:string[])=>(await exec('/usr/bin/git',['-C',root,...args])).stdout.trim();
 try{
  await git('init');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  await writeFile(root+'/v','1');await git('add','v');await git('commit','-m','one');const baseline=await git('rev-parse','HEAD');
  await writeFile(root+'/v','2');await git('commit','-am','two');const candidate=await git('rev-parse','HEAD');
  await mkdir(root+'/bin');await writeFile(root+'/bin/git','#!/bin/sh\nif [ "$3" = worktree ] && [ "$4" = remove ]; then exit 73; fi\nexec /usr/bin/git "$@"\n',{mode:0o700});
  const source='setTimeout(()=>{},5000);';await writeFile(root+'/runner.mjs',source);
  process.env.PATH=root+'/bin:'+(oldPath??'');
  const evaluator=new ExperimentEvaluator(root,root+'/evidence',root+'/runner.mjs',createHash('sha256').update(source).digest('hex'),500);
  const result=await evaluator.evaluate({baseline,candidate,hypothesis:'timeout and cleanup interaction',metric:'cost',direction:'lower',minimumDelta:1});
  assert.equal(result.verdict,'inconclusive');assert.equal(result.cleanup?.complete,false);assert.equal(result.cleanup?.remainingWorktrees.length,1);
  assert.match(result.reason,/cleanup incomplete/);
  assert.deepEqual(JSON.parse(await readFile(root+'/evidence/'+result.id+'.json','utf8')),result);
 }finally{
  if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
  const dirs=(await git('worktree','list','--porcelain')).split('\n').filter(l=>l.startsWith('worktree ')).map(l=>l.slice(9)).filter(p=>p!==root);
  for(const dir of dirs){await git('worktree','remove','--force',dir);await rm(dir.replace(/\/(baseline|candidate)$/,''),{recursive:true,force:true});}
  await rm(root,{recursive:true,force:true});
 }
});
