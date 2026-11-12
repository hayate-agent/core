import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCompactionSettings } from '../src/worker-context.js';
import { contextPolicy } from '../src/context-maintenance.js';
import { PiRuntime } from '../src/runtime/pi.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const native = { reserveTokens: 16384, keepRecentTokens: 20000 };
test('absolute child trigger does not scale up with a million-token model', () => {
  for (const window of [200000, 1000000]) {
    const p = workerCompactionSettings('dispatch:id:claim', window, native)!;
    assert.equal(window - p.reserveTokens, 131072);
    assert.equal(p.keepRecentTokens, 20000);
    assert.equal(p.enabled, true);
  }
  assert.equal(workerCompactionSettings('matrix:main', 200000, native), undefined);
  assert.equal(workerCompactionSettings('dispatch:x', undefined, native), undefined);
  assert.equal(workerCompactionSettings('subagent:x', 32000, native)!.reserveTokens, 16384);
  assert.equal(workerCompactionSettings('dispatch:x', 200000, {reserveTokens:180000,keepRecentTokens:8000})!.reserveTokens,180000);
  assert.throws(() => contextPolicy({workerContextTokens:0}));
  assert.throws(() => contextPolicy({workerContextTokens:8192.5}));
});

test('real PI worker applies native budget before prompt even with harness ownership; main stays unchanged', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'worker-context-'));
  // Do not inherit whichever provider/model happens to be the SDK default on
  // a developer host or the credential-free CI runner. Unknown capacity must
  // remain unknown in production; this test explicitly supplies a known window.
  const models = await ModelRuntime.create();
  models.registerProvider('worker-context-fixture', {api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline-fixture',models:[{
    id:'known-window',name:'Known window fixture',api:'openai-completions',reasoning:false,input:['text'],contextWindow:200000,maxTokens:4096,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
  }]});
  const runtime = new PiRuntime({cwd:home,sessionsDir:path.join(home,'sessions'),skillPaths:[],model:'worker-context-fixture/known-window',
    personaSections:async()=>[],compactionOwner:()=> 'harness',workerContextTokens:()=>32000,
    approvals:{mode:'off',tools:[]}});
  (runtime as any).modelRuntime = async () => models;
  try {
    for (const key of ['dispatch:test:claim','subagent:test','matrix:test']) {
      const wrapped:any = await runtime.open(key); const session = wrapped.session;
      assert.ok(session.model);
      session.prompt = async () => {
        const p = session.settingsManager.getCompactionSettings(session.model);
        if (key === 'matrix:test') assert.equal(p.enabled,false);
        else { assert.equal(p.enabled,true); assert.ok(session.model.contextWindow-p.reserveTokens<=32000); assert.ok(p.keepRecentTokens<=10666); }
      };
      session.waitForIdle=async()=>{};
      await wrapped.prompt('bounded fixture');
      await wrapped.dispose();
    }
  } finally {await rm(home,{recursive:true,force:true});}
});
