import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
test('real SDK: empty explicit /new survives separate-process restart without old history or fabricated messages', async t => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'native-empty-reset-'));
 t.after(() => rm(home, { recursive: true, force: true }));
 const code = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PiRuntime} from './src/runtime/pi.ts';
const home=process.env.TEST_HOME;
const runtime=new PiRuntime({cwd:home,sessionsDir:home+'/sessions',skillPaths:[],tools:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]}});
const phase=process.env.PHASE;
const wrapped=await runtime.open('matrix:reset-target',phase==='reset'?{fresh:true}:{});
const manager=wrapped.session.sessionManager;
try {
 if(phase==='old')manager.appendMessage({role:'user',content:'OLD_MANDATE_DO_NOT_RESTORE',timestamp:Date.now()});
 if(phase==='reset'){
  assert.ok(fs.existsSync(manager.getSessionFile()),'explicit empty context must be durable before reset acknowledgement');
  assert.ok(!manager.getEntries().some(e=>e.type==='message'),'do not fabricate a user/assistant turn to force SDK persistence');
 }
 if(phase==='check'||phase==='reopen'){
  assert.equal(wrapped.status().sessionId,process.env.FRESH_ID);
  assert.ok(!JSON.stringify(wrapped.session.messages).includes('OLD_MANDATE_DO_NOT_RESTORE'));
  if(phase==='check')manager.appendMessage({role:'user',content:'NEW_GENUINE_INPUT',timestamp:Date.now()});
  else assert.ok(JSON.stringify(wrapped.session.messages).includes('NEW_GENUINE_INPUT'));
 }
 console.log(JSON.stringify({id:wrapped.status().sessionId,file:manager.getSessionFile()}));
}finally{await wrapped.dispose();}
`;
 const run = async (phase: string, freshId?: string) => {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { env: { ...process.env, TEST_HOME: home, PHASE: phase, FRESH_ID: freshId }, timeout: 20000, maxBuffer: 1024*1024 });
  return JSON.parse(stdout.trim());
 };
 const old = await run('old'); const fresh = await run('reset'); assert.notEqual(fresh.id, old.id);
 await run('check', fresh.id); await run('reopen', fresh.id);
});
