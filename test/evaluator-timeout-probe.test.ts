import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ExperimentEvaluator} from '../src/improvement-experiments.js';
const exec=promisify(execFile);
test('full evaluator timeout cleans ordinary descendant and persists inconclusive evidence',async()=>{
 const root=await mkdtemp('/tmp/snape-full-timeout-data-');let pid:number|undefined;
 const git=async(...args:string[])=>(await exec('git',['-C',root,...args])).stdout.trim();
 try{
  await git('init');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  await writeFile(root+'/value','1');await git('add','value');await git('commit','-m','baseline');const baseline=await git('rev-parse','HEAD');
  await writeFile(root+'/value','2');await git('commit','-am','candidate');const candidate=await git('rev-parse','HEAD');
  const source=`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(root+'/child.pid')},String(c.pid));setTimeout(()=>{},10000);`;
  await writeFile(root+'/runner.mjs',source);
  const evaluator=new ExperimentEvaluator(root,root+'/evidence',root+'/runner.mjs',createHash('sha256').update(source).digest('hex'),1000);
  const result=await evaluator.evaluate({baseline,candidate,hypothesis:'timeout must clean ordinary descendants',metric:'cost',direction:'lower',minimumDelta:1});
  assert.equal(result.verdict,'inconclusive');
  pid=Number(await readFile(root+'/child.pid','utf8'));
  let live=false;try{process.kill(pid,0);live=true;}catch{}
  if(live){try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');live=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]!=='Z';}catch{live=false;}}
  assert.equal(live,false);
  assert.equal((await git('worktree','list','--porcelain')).split('worktree ').length,2);
  assert.equal(JSON.parse(await readFile(root+'/evidence/'+result.id+'.json','utf8')).verdict,'inconclusive');
  console.log(JSON.stringify({verdict:result.verdict,descendantSurvives:false,worktreesCleaned:true,finalEvidencePersisted:true}));
 }finally{if(pid){try{process.kill(pid,'SIGKILL');}catch{}}await rm(root,{recursive:true,force:true});}
});
