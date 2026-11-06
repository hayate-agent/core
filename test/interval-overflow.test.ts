// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInterval } from '../src/interval.js';
import { COMMANDS, type CommandContext } from '../src/commands.js';
import { Harness } from '../src/harness.js';
import { FakeRuntime } from './fakes.js';

test('interval parser refuses nonfinite and unsafe integer totals',()=>{
 assert.equal(parseInterval('9'.repeat(400)+'d'),undefined);
 assert.equal(parseInterval('999999999999999999d'),undefined);
 assert.equal(parseInterval('1h30m'),5400000);
});

test('overflow interval cannot install null recurring timestamps after persistence',async(t)=>{
 const harness=new Harness({runtime:new FakeRuntime(),tickMs:60000,log:()=>{}});
 t.after(()=>harness.stop(0));
 const command=COMMANDS.find(c=>c.name==='heartbeat')!;
 const result=await command.run('every '+'9'.repeat(400)+'d synthetic',{sessionKey:'probe',source:'channel',text:''} as any,{harness} as CommandContext);
 assert.match(String(result),/invalid interval/);
 assert.equal(harness.state('probe').heartbeat,undefined);
 const restored=JSON.parse(JSON.stringify(harness.snapshotSessions()));
 assert.ok(!restored.some((s:any)=>s.heartbeat?.everyMs===null || s.heartbeat?.nextAt===null),String(result));
});
