import assert from 'node:assert/strict';
import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {promisify} from 'node:util';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
const original=cp.execFile;let child:ReturnType<typeof cp.execFile>|undefined;let options:any;
const forwarding=(file:any,args:any,opts:any,cb:any)=>{options={...opts};assert.equal(opts.timeout,600000);return child=original(file,args,{...opts,timeout:500},cb);};
Object.defineProperty(forwarding,promisify.custom,{value:(file:any,args:any,opts:any)=>new Promise((resolve,reject)=>forwarding(file,args,opts,(err:any,stdout:any,stderr:any)=>err?reject(err):resolve({stdout,stderr})))});
(cp as any).execFile=forwarding;syncBuiltinESMExports();
const {Scheduler}=await import('../../src/scheduler.js');
const dir=await mkdtemp(path.join(os.tmpdir(),'scheduler-forward-'));
let settled=false,failure:any;let pending:Promise<void>|undefined;
try{
 const file=path.join(dir,'synthetic');const ready=path.join(dir,'ready'),term=path.join(dir,'term');
 await writeFile(file,`#!${process.execPath}\nconst fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(term)},'received'));fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);\n`);await chmod(file,0o700);
 const harness={paused:false,withForegroundWork:async<T>(work:()=>Promise<T>)=>work(),enqueue:()=>{throw Error('unexpected enqueue');},deliver:()=>{throw Error('unexpected delivery');}};
 const scheduler=new Scheduler(harness as any,{scriptsDir:dir,timezone:'UTC',log:()=>{}});
 pending=scheduler.runJob({name:'synthetic',schedule:'* * * * *',script:'synthetic',no_agent:true}).then(()=>{settled=true;},err=>{settled=true;failure=err;});
 let readyPid:number|undefined;
 for(let n=0;n<60;n++){try{readyPid=Number(await readFile(ready,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,5));}}
 assert.equal(readyPid,child?.pid,'readiness must precede real timeout');
 await new Promise(r=>setTimeout(r,800));
 let alive=false;try{process.kill(child!.pid!,0);alive=true;}catch{}
 let termReceived=false;try{termReceived=(await readFile(term,'utf8'))==='received';}catch{}
 const result={options,settled,alive,termReceived,signal:failure?.signal};console.log(JSON.stringify(result));
 if(process.env.EXPECT_HARD==='1'){assert.equal(settled,true);assert.equal(alive,false);assert.equal(failure?.signal,'SIGKILL');}
 else{assert.equal(settled,false);assert.equal(alive,true);assert.equal(termReceived,true);}
}finally{
 child?.kill('SIGKILL');await pending;await rm(dir,{recursive:true,force:true});(cp as any).execFile=original;syncBuiltinESMExports();
}
