// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Scheduler } from '../src/scheduler.js';

for(const failure of ['yaml','schedule'] as const)test(`failed ${failure} reload preserves complete previous schedule`,async(t)=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'scheduler-reload-'));
 const file=path.join(dir,'jobs.yaml');
 const scheduler=new Scheduler({paused:false} as any,{jobsFile:file,timezone:'UTC',log:()=>{}});
 t.after(async()=>{scheduler.stop();await rm(dir,{recursive:true,force:true});});
 await writeFile(file,'jobs:\n  - name: original\n    schedule: "0 * * * *"\n    prompt: original\n');
 await scheduler.load();const before=scheduler.list();
 assert.equal(before[0].enabled,true);
 await writeFile(file,failure==='yaml'?'jobs: [':`jobs:\n  - name: candidate\n    schedule: "0 * * * *"\n  - name: broken\n    schedule: invalid\n`);
 await assert.rejects(scheduler.load());
 assert.deepEqual(scheduler.list(),before);
 assert.equal(scheduler.find('candidate'),undefined);
 await writeFile(file,'jobs:\n  - name: recovered\n    schedule: "0 * * * *"\n');
 await scheduler.load();assert.deepEqual(scheduler.list().map(j=>j.name),['recovered']);
 assert.equal(scheduler.list()[0].enabled,true);
 scheduler.setEnabled('recovered',false);
 await scheduler.load();
 assert.equal(scheduler.list()[0].enabled,false,'pause override survives replacement');
 await rm(file);await scheduler.load();
 assert.deepEqual(scheduler.list(),[],'missing jobs file disables and clears the schedule');
});
