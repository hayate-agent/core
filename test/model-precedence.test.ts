import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Real SDK session creation, transcript replay, resource reload and provider snapshots;
// only generation/auth are replaced, so this never calls a model or reads personal PI state.
for (const external of [false, true]) test(`model precedence survives real PI resume (${external ? "provider" : "native"})`, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "model-precedence-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import {PiRuntime} from './src/runtime/pi.ts';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {FilesystemSessionProvider} from './src/sessions.ts';
const home=process.env.TEST_HOME;
const models=await ModelRuntime.create();
models.checkAuth=async()=>true;
const available=models.getModels();
const a=available.find(m=>m.reasoning && m.provider==='anthropic');
const b=available.find(m=>m.reasoning && m.provider==='openai');
assert.ok(a && b, 'SDK catalog must include two reasoning models');
const A=a.provider+'/'+a.id, B=b.provider+'/'+b.id;
let defaults={revision:0,model:A,thinking:'high'};
const provider=new FilesystemSessionProvider(home+'/store');
const options={cwd:home,sessionsDir:home+'/sessions',skillPaths:[],tools:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},modelDefaults:()=>({...defaults}),...(${external} ? {sessionProvider:()=>provider}: {})};
const make=()=>{const r=new PiRuntime(options);r.modelRuntime=async()=>models;return r};
let runtime=make();
let local=await runtime.open('local');
const id=local.status().sessionId;
local.session.sessionManager.appendMessage({role:'user',content:'Persist conversation',timestamp:1});
await local.setModel(B);
await local.setThinking('low');
const beforeInvalid=JSON.stringify(defaults);
await assert.rejects(local.setModel('malformed'),/model must be/);
await assert.rejects(local.setModel('missing/unregistered'),/unknown model/);
const checkAuth=models.checkAuth;
models.checkAuth=async()=>false;
await assert.rejects(local.setModel(A),/No API key/);
models.checkAuth=checkAuth;
await assert.rejects(local.setThinking('invalid'),/thinking must be/);
assert.equal(local.status().model,B,'rejected selection retains active model');
assert.equal(local.status().thinking,'low');
assert.equal(JSON.stringify(defaults),beforeInvalid,'local commands never mutate globals');
if (${external}) {
 const saved=await provider.load(id);
 assert.ok(saved.entries.some(e=>e.type==='custom' && e.customType==='harness-session-selection-v1' && e.data.model===B && e.data.thinking==='low'),'selection checkpointed before command acknowledgement');
}
await local.dispose();
runtime=make();
local=await runtime.open('local',{sessionId:id});
assert.equal(local.status().model,B,'explicit local model must survive restart');
assert.equal(local.status().thinking,'low','explicit local thinking must survive restart');
const prepare=w=>{w.session.prompt=async()=>{};w.session.waitForIdle=async()=>{}};
prepare(local);
defaults.revision++;
await local.prompt('unrelated settings revision');
assert.equal(local.status().model,B);
assert.equal(local.status().thinking,'low');
await runtime.reload();
await local.prompt('reload');
assert.equal(local.status().model,B);
assert.equal(local.status().thinking,'low');
defaults={revision:2,model:A,thinking:'medium'};
await local.prompt('global thinking changed');
assert.equal(local.status().model,B);
assert.equal(local.status().thinking,'low');
await local.prompt('review',{model:A,thinking:'high'});
assert.equal(local.status().model,B,'temporary review model restored');
assert.equal(local.status().thinking,'low','temporary review thinking restored');
if (${external}) {
 const saved=await provider.load(id);
 const lastModel=saved.entries.findLast(e=>e.type==='model_change');
 const lastThinking=saved.entries.findLast(e=>e.type==='thinking_level_change');
 assert.equal(lastModel.provider+'/'+lastModel.modelId,B,'prompt checkpoints restored model');
 assert.equal(lastThinking.thinkingLevel,'low','prompt checkpoints restored thinking');
}
await local.dispose();
local=await make().open('local',{sessionId:id});
assert.equal(local.status().model,B,'review did not persist local provenance');
assert.equal(local.status().thinking,'low');
await local.dispose();
let inherited=await runtime.open('inherited');
inherited.session.sessionManager.appendMessage({role:'user',content:'Inherited model',timestamp:1});
prepare(inherited);
await inherited.prompt('temporary review on inherited session',{model:B,thinking:'off'});
await inherited.dispose();
defaults={revision:2,model:B,thinking:'medium'};
inherited=await make().open('inherited');
assert.equal(inherited.status().model,B,'saved inherited model must not pin stale defaults');
assert.equal(inherited.status().thinking,'medium');
prepare(inherited);
// Same mechanism as /model reset --global: effective installation values return.
defaults={revision:3,model:A,thinking:'high'};
await inherited.prompt('global reset');
assert.equal(inherited.status().model,A);
assert.equal(inherited.status().thinking,'high');
await inherited.dispose();
// Local intent is per field, including selecting the already inherited value.
let modelOnly=await runtime.open('model-only');
modelOnly.session.sessionManager.appendMessage({role:'user',content:'Model only',timestamp:1});
await modelOnly.setModel(A);
await modelOnly.dispose();
let thinkingOnly=await runtime.open('thinking-only');
thinkingOnly.session.sessionManager.appendMessage({role:'user',content:'Thinking only',timestamp:1});
await thinkingOnly.setThinking('low');
await thinkingOnly.dispose();
defaults={revision:4,model:B,thinking:'medium'};
modelOnly=await make().open('model-only');
assert.equal(modelOnly.status().model,A,'explicit same-model selection is durable');
assert.equal(modelOnly.status().thinking,'medium','unselected thinking inherits global');
await modelOnly.dispose();
thinkingOnly=await make().open('thinking-only');
assert.equal(thinkingOnly.status().model,B,'unselected model inherits global');
assert.equal(thinkingOnly.status().thinking,'low');
await thinkingOnly.dispose();
defaults={revision:5,model:A,thinking:'high'};
const fresh=await make().open('local',{fresh:true});
assert.equal(fresh.status().model,A);
assert.equal(fresh.status().thinking,'high');
await fresh.dispose();
console.log('PRECEDENCE_OK');`;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, TEST_HOME: home, PI_CODING_AGENT_DIR: home }, timeout: 30000,
    });
    assert.match(result.stdout, /PRECEDENCE_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
