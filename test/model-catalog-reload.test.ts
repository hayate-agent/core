import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Real SDK sessions and model catalog; only auth/generation are replaced.
test("explicit model reload refreshes same-ID protocol in existing sessions without losing selection/history", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "catalog-reload-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {PiRuntime} from './src/runtime/pi.ts';
const home=process.env.TEST_HOME;
const config=api=>JSON.stringify({providers:{test:{baseUrl:'http://127.0.0.1:1/v1',api,apiKey:'synthetic-test-only',models:[{id:'same-id',name:'Test',reasoning:true,input:['text'],contextWindow:32000,maxTokens:1000}]}}});
await writeFile(home+'/models.json',config('openai-responses'));
const models=await ModelRuntime.create({modelsPath:home+'/models.json'});
models.checkAuth=async()=>({configured:true,authorized:true});
const runtime=new PiRuntime({cwd:home,sessionsDir:home+'/sessions',skillPaths:[],tools:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},model:'test/same-id',thinking:'medium'});
runtime.modelsRuntime=models;
const local=await runtime.open('local');
await local.setModel('test/same-id');await local.setThinking('low');
local.session.sessionManager.appendMessage({role:'user',content:'retain this conversation',timestamp:1});
local.session.prompt=async()=>{};local.session.waitForIdle=async()=>{};
assert.equal(local.session.model.api,'openai-responses');
await writeFile(home+'/models.json',config('openai-completions'));
await runtime.reload();await local.prompt('resource reload only');
assert.equal(local.session.model.api,'openai-responses','skill reload must not reload models');
await runtime.reloadModels();await local.prompt('next turn');
assert.equal(local.session.model.api,'openai-completions','same provider/model ID must pick up changed protocol');
assert.equal(local.status().model,'test/same-id');assert.equal(local.status().thinking,'low');
assert.ok(local.session.sessionManager.getBranch().some(e=>e.message?.content==='retain this conversation'));
const advisory=await runtime.open('advisory',{ephemeral:true,assessmentPurpose:'supervisor'});
await advisory.setModel('test/same-id');assert.equal(advisory.session.model.api,'openai-completions');await advisory.dispose();
let release;const held=new Promise(r=>release=r);local.session.prompt=()=>held;
const working=local.prompt('held turn');await new Promise(r=>setTimeout(r,20));
await assert.rejects(runtime.reloadModels(),/busy/);
release();await working;
let sends=0;local.session.prompt=async()=>{sends++};
await writeFile(home+'/models.json','{ PRIVATE_INVALID_CATALOG');
await assert.rejects(runtime.reloadModels(),e=>/Model catalog reload failed/.test(e.message)&&!e.message.includes('PRIVATE'));
await assert.rejects(local.prompt('must not send'),/Model catalog reload failed/);assert.equal(sends,0);
await writeFile(home+'/models.json',config('openai-responses'));await runtime.reloadModels();await local.prompt('repaired catalog');
assert.equal(local.session.model.api,'openai-responses');assert.equal(sends,1);
await local.dispose();
// Disposed sessions must not accumulate as permanent reload blockers.
assert.equal(runtime.activeSessions.size,0);
await runtime.reloadModels();
`;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: path.resolve("."), env: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_HOME: home }, timeout: 30000,
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});
