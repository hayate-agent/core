import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {mkdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The builtin forwarding wrapper stays in an ordinary, isolated Node process.
test('scheduler timeout terminates a direct script that ignores SIGTERM', async()=>{
 let stdout='',stderr='';const dir=mkdtempSync(path.join(os.tmpdir(),'scheduler-timeout-'));const t0=Date.now();
 try{
  ({stdout,stderr}=await promisify(execFile)(process.execPath,['--import','tsx','test/fixtures/scheduler-deadline-probe.ts'],{
   env:{...process.env,EXPECT_HARD:'1'},timeout:10000,
  }));
 }catch(err:any){
  // Retain the child's logs for diagnosis; never swallow the failure.
  mkdirSync(dir,{recursive:true});
  writeFileSync(`${dir}/${Date.now()}.log`,`${err.stdout??''}\n${err.stderr??''}\n${err.message}`);
  throw err;
 }
 const wall=Date.now()-t0;
 // Retain the successful run's output as proof of SIGKILL termination.
 mkdirSync(dir,{recursive:true});writeFileSync(`${dir}/pass-${Date.now()}.log`,`${stdout}\n${stderr}\nwallMs=${wall}\n`);
 const result=JSON.parse(stdout.trim());
 assert.ok(wall>=4000&&wall<10000,`wall clock spans the 4000ms fixture deadline: ${wall}`);
 assert.deepEqual(Object.keys(result.options).sort(),['killSignal','maxBuffer','timeout'],'exec spawn options carry no env/cwd override');
 assert.equal(result.termReceived,false,'SIGKILL is sent directly; child never gets to handle SIGTERM');
 assert.equal(result.options.timeout,600000);
 assert.equal(result.options.maxBuffer,4*1024*1024);
 assert.equal(result.options.killSignal,'SIGKILL');
 assert.ok(Number.isInteger(result.readyPid)&&result.readyPid>0,'ready pid is a whole positive pid');
 assert.ok(result.readyMs>=0&&result.readyMs<3800,'child ready before the real timeout');
 assert.equal(result.settled,true);
 assert.equal(result.alive,false);
 assert.equal(result.signal,'SIGKILL');
});

test('SIGTERM after readiness is received and ignored, then the deadline escalates to SIGKILL', async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'scheduler-timeout-'));
 let stdout='',stderr='';
 try{
  ({stdout,stderr}=await promisify(execFile)(process.execPath,['--import','tsx','test/fixtures/scheduler-deadline-probe.ts'],{
   env:{...process.env,EXPECT_HARD:'1',SEND_TERM:'1'},timeout:10000,
  }));
 }catch(err:any){
  writeFileSync(`${dir}/term-${Date.now()}.log`,`${err.stdout??''}\n${err.stderr??''}\n${err.message}`);
  throw err;
 }
 writeFileSync(`${dir}/term-pass-${Date.now()}.log`,`${stdout}\n${stderr}\n`);
 const r=JSON.parse(stdout.trim());
 assert.equal(r.termSent,true);
 assert.equal(r.termSeen,true,'child received SIGTERM');
 assert.equal(r.aliveAfterTerm,true,'child ignored SIGTERM and stayed alive');
 assert.equal(r.settledAfterTerm,false,'scheduler job still pending after SIGTERM');
 assert.equal(r.termReceived,true);
 assert.equal(r.settled,true);
 assert.equal(r.alive,false);
 assert.equal(r.signal,'SIGKILL');
 assert.ok(r.readyMs>=0&&r.readyMs<3800);
});
