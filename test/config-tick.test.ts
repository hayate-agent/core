import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {defaultConfig,loadConfig} from '../src/config.js';

test('configuration rejects timer coercion and overflow instead of creating 1ms tick',()=>{
 for(const tickMs of [0,-1,0.5,NaN,Infinity,2147483648,'15000',null])
  assert.throws(()=>defaultConfig({loop:{tickMs,busyMode:'queue',drainSeconds:60}} as never),/loop.tickMs/);
 for(const tickMs of [1,15000,2147483647])
  assert.equal(defaultConfig({loop:{tickMs,busyMode:'queue',drainSeconds:60}}).loop.tickMs,tickMs);
 assert.equal(defaultConfig().loop.tickMs,15000);
});
test('YAML tick overflow fails at config loading boundary',async(t)=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'config-tick-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'harness.yaml'),'loop:\n  tickMs: 2147483648\n');
 await assert.rejects(loadConfig(dir),/loop.tickMs/);
});
