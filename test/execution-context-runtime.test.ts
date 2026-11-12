import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("real PI concurrent bash/plugin tools and persona use the bound context, not process cwd", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-workspace-sdk-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {PiRuntime} from './src/runtime/pi.ts';
import {ExecutionContexts} from './src/execution-contexts.ts';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
const home=process.env.TEST_HOME;
const a=home+'/repo-a',b=home+'/repo-b';await mkdir(a);await mkdir(b);
const bindings=new ExecutionContexts(home+'/contexts.json',home,key=>key==='worker'?'stream-a':undefined);
await bindings.load();await bindings.bind('stream-a',{cwd:a});await bindings.bind('stream-b',{cwd:b});
const models=await ModelRuntime.create();models.checkAuth=async()=>true;
const model=models.getModels().find(m=>m.provider==='anthropic');assert(model);
await models.setRuntimeApiKey(model.provider,'fixture-not-a-secret');
const observed=[];const processCwd=process.cwd();
const runtime=new PiRuntime({cwd:home,sessionsDir:home+'/sessions',skillPaths:[],
 executionContext:key=>bindings.get(key),tools:['bash','plugin_context_probe'],
 pluginTools:()=>[{name:'plugin_context_probe',description:'Observe real tool binding',parameters:{type:'object',properties:{}},
 execute:async(_input,context)=>{observed.push([context.sessionKey,context.cwd]);return 'CONTEXT '+context.cwd;}}],
 personaSections:async cwd=>['WORKSPACE '+cwd],approvals:{mode:'off',tools:[]},
 modelDefaults:()=>({revision:0,model:model.provider+'/'+model.id})});
runtime.modelRuntime=async()=>models;
async function run(key,expected){
 const wrapped=await runtime.open(key);const session=wrapped.session;
 session.settingsManager.setCompactionEnabled(false);let calls=0;
 session.agent.streamFunction=(_model,context)=>{
  assert.match(session.systemPrompt,new RegExp(expected));
  if(calls++) {const text=JSON.stringify(context);assert(text.includes(expected));assert(text.includes('CONTEXT '+expected));}
  const stream=createAssistantMessageEventStream();
  const content=calls===1?[{type:'toolCall',id:'pwd',name:'bash',arguments:{command:'pwd'}},{type:'toolCall',id:'context',name:'plugin_context_probe',arguments:{}}]:[{type:'text',text:'verified'}];
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,
   usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
   stopReason:calls===1?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;
 };
 await wrapped.prompt('Check context with tools');assert.equal(calls,2);await wrapped.dispose();
}
await Promise.all([run('stream-a',a),run('stream-b',b)]);await run('worker',a);
assert.equal(process.cwd(),processCwd);
assert.deepEqual(observed.sort(),[['stream-a',a],['stream-b',b],['worker',a]].sort());
console.log('EXECUTION_CONTEXT_SDK_OK');`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: process.cwd(), env: { ...process.env, TEST_HOME: home, PI_CODING_AGENT_DIR: home }, timeout: 90000, maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, /EXECUTION_CONTEXT_SDK_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
