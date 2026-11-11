import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {ExecutionStore} from '../src/execution.js';
import {Dispatcher} from '../src/dispatcher.js';

test('upgrade never retries historical internal pauses but preserves truly running and accepted workers',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'worker-enroll-'));const file=path.join(dir,'executions.json');const s=new ExecutionStore(file);await s.load();
 const a=await s.submit('parent','old','old','direct');const c=await s.claim(a.id);await s.fail(a.id,c.token!,'runtime-failure');
 const running=await s.submit('parent','running','running','direct');await s.claim(running.id);
 const ready=await s.submit('parent','ready','ready','direct');
 // Exact pre-upgrade disk representation has no enrollment marker.
 const disk=JSON.parse(await readFile(file,'utf8'));for(const e of disk.executions)delete e.recoveryEnrollment;await writeFile(file,JSON.stringify(disk));
 const loaded=new ExecutionStore(file);await loaded.load();await loaded.holdLegacyRecovery();
 const rows=loaded.list();assert.equal(rows.find(e=>e.id===a.id)!.recoveryEnrollment,'held-legacy');assert.equal(rows.find(e=>e.id===running.id)!.recoveryEnrollment,'current');assert.equal(rows.find(e=>e.id===ready.id)!.recoveryEnrollment,'current');
 const calls:string[]=[];const strategy={name:'direct',version:1,replaySafe:true,reconcile:true,execute:async(task:any)=>{calls.push(task.id);return 'done';}};
 const d=new Dispatcher(loaded,strategy,4,async()=>{},()=>{});t.after(async()=>{await d.stop();await rm(dir,{recursive:true,force:true});});await d.start();await d.waitForExecution(running.id);await d.waitForExecution(ready.id);await d.kick();
 assert.ok(!calls.includes(a.id));assert.equal(loaded.list().find(e=>e.id===a.id)!.status,'paused');
 await loaded.control(a.id,'resume');assert.equal(loaded.list().find(e=>e.id===a.id)!.recoveryEnrollment,'current');
});
