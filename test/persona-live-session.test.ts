import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const external of [false, true]) test(`real PI next-call persona refresh preserves history (${external ? 'external' : 'native'})`, async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'persona-live-'));
 try {
 const code = `
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {PiRuntime} from './src/runtime/pi.ts';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {FilesystemSessionProvider} from './src/sessions.ts';
import {loadPersona,personaSections} from './src/persona.ts';
import {SettingsService} from './src/settings.ts';
import {Harness} from './src/harness.ts';
import {DispatcherRuntime} from './src/dispatcher-runtime.ts';
import {ExecutionStore} from './src/execution.ts';
const home=process.env.TEST_HOME;
const dir=home+'/SOUL.md.d'; await mkdir(dir);
await mkdir(home+'/settings.d'); await writeFile(home+'/settings.local.yaml','model: old/model');
const settings=new SettingsService(home+'/settings.local.yaml',{}); await settings.load();
const files={soul:home+'/SOUL.md',voice:home+'/VOICE.md',personalitiesDir:home+'/profiles'};
await writeFile(files.soul,'OWN SOUL'); await writeFile(files.voice,'OWN VOICE');
const models=await ModelRuntime.create(); models.checkAuth=async()=>true;
const model=models.getModels().find(m=>m.provider==='anthropic'); assert.ok(model);
await models.setRuntimeApiKey(model.provider,'fixture-not-a-secret');
const provider=new FilesystemSessionProvider(home+'/store');
const runtime=new PiRuntime({cwd:home,agentDir:home,sessionsDir:home+'/sessions',skillPaths:[],tools:['plugin_edit_persona'],
beforeRequest:async()=>{await settings.reload();},
pluginTools:()=>[{name:'plugin_edit_persona',description:'Fixture edit',parameters:{type:'object',properties:{}},execute:async()=>{await writeFile(dir+'/00.md','ITERATION EDIT');expected='ITERATION EDIT';return 'TOOL RESULT RETAINED';}}],
personaSections:async()=>personaSections(await loadPersona(files)),approvals:{mode:'off',tools:[]},
modelDefaults:()=>({revision:0,model:model.provider+'/'+model.id}),...(${external}?{sessionProvider:()=>provider}:{})});
runtime.modelRuntime=async()=>models;
let expected='FIRST OVERLAY';
for(const key of ['mem:parent','dispatch:task:claim','subagent:child']) {
 await writeFile(dir+'/00.md','FIRST OVERLAY');
 const wrapped=await runtime.open(key); const session=wrapped.session;
 session.settingsManager.setCompactionEnabled(false);
 let contexts=[]; expected='FIRST OVERLAY';
 session.agent.streamFunction=(_model,context)=>{
  const snapshot=JSON.stringify(context); contexts.push(snapshot);
  assert.match(snapshot,new RegExp(expected)); assert.match(snapshot,/OWN SOUL/); assert.match(snapshot,/OWN VOICE/);
  assert.match(session.systemPrompt,new RegExp(expected));
  if(expected!=='FIRST OVERLAY') assert.doesNotMatch(session.systemPrompt,/FIRST OVERLAY/);
  const stream=createAssistantMessageEventStream();
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:contexts.length===1?[{type:'text',text:'answer 1'},{type:'toolCall',id:'edit',name:'plugin_edit_persona',arguments:{}}]:[{type:'text',text:'answer '+contexts.length}],
   usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:contexts.length===1?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;
 };
 const id=wrapped.status().sessionId;
 await wrapped.prompt('first request',{instructions:'CURRENT RUN'});
 assert.equal(contexts.length,2,'continuation iteration refresh');
 await writeFile(dir+'/00.md','NEXT TURN EDIT'); await writeFile(dir+'/01.md','ADDED OVERLAY'); expected='NEXT TURN EDIT';
 for(let i=2;i<50;i++) await writeFile(dir+'/'+String(i).padStart(2,'0')+'.md','OVERLAY '+i);
 await wrapped.prompt('second request');
 assert.match(contexts.at(-1),/OVERLAY 49/);
 assert.match(session.systemPrompt,/OVERLAY 49/);
 await writeFile(home+'/settings.d/50.yaml','model: next/model\\nreasoningEffortNoneModels: [fixture/model]');
 assert.equal(wrapped.status().sessionId,id); assert.match(contexts.at(-1),/first request/); assert.match(contexts.at(-1),/answer 1/); assert.match(contexts.at(-1),/TOOL RESULT RETAINED/);
 assert.match(contexts.at(-1),/ADDED OVERLAY/); assert.doesNotMatch(session.systemPrompt,/CURRENT RUN|ITERATION EDIT/);
 await rm(dir+'/01.md'); expected='NEXT TURN EDIT'; await wrapped.prompt('third request');
 assert.doesNotMatch(session.systemPrompt,/ADDED OVERLAY/);
 assert.deepEqual(settings.effective().reasoningEffortNoneModels,['fixture/model']);
 assert.equal(settings.effective().model,'old/model'); assert.ok(settings.restartPending.includes('model'));
 const calls=contexts.length;
 await writeFile(dir+'/00.md',Buffer.from([255])); await wrapped.prompt('repair using old prompt');
 assert.equal(contexts.length,calls+1); assert.match(session.systemPrompt,/NEXT TURN EDIT/);
 await writeFile(dir+'/00.md','RECOVERED'); expected='RECOVERED'; await wrapped.prompt('recovered');
 assert.equal(contexts.length,calls+2); assert.match(contexts.at(-1),/third request/);
 await wrapped.dispose();
 for(let i=2;i<50;i++) await rm(dir+'/'+String(i).padStart(2,'0')+'.md');
 if(${external}){const saved=await provider.load(id);assert.match(JSON.stringify(saved),/first request/);}
}
// The actual direct-worker bridge enters ordinary Harness/PI sessions, not
// merely a PiSession whose key happens to resemble a worker key.
const store=new ExecutionStore(home+'/worker-ledger.json'); await store.load();
const task=await store.submit('parent','overlay-worker','check current instructions','direct');
const claimed=await store.claim(task.id);
const harness=new Harness({runtime,tickMs:60000,busyMode:'queue'});
const bridge=new DispatcherRuntime(harness,store); harness.addChannel(bridge.channel);
const workerContext=[]; const originalOpen=runtime.open.bind(runtime);
runtime.open=async(...args)=>{const wrapped=await originalOpen(...args);wrapped.session.settingsManager.setCompactionEnabled(false);
 wrapped.session.agent.streamFunction=(_model,context)=>{workerContext.push(wrapped.session.systemPrompt);
  const stream=createAssistantMessageEventStream();const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'ok'}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message});stream.end();});return stream;};return wrapped;};
expected='WORKER OVERLAY'; await writeFile(dir+'/00.md',expected);
const answer=await bridge.strategy.execute(claimed,{signal:new AbortController().signal,
 intent:(key,replay)=>store.intent(task.id,claimed.token,key,replay),
 checkpoint:value=>store.checkpoint(task.id,claimed.token,value),
 settleIntent:(key,result,checkpoint)=>store.settleIntent(task.id,claimed.token,key,result,checkpoint)});
assert.match(answer,/ok/); assert.match(workerContext.at(-1),/WORKER OVERLAY/);
const key='dispatch:'+task.id+':'+claimed.token;
expected='WORKER NEXT CALL';await writeFile(dir+'/00.md',expected);
await harness.accept({id:'worker-next',sessionKey:key,text:'next call',source:'api'});await harness.waitForSessionIdle(key);
assert.match(workerContext.at(-1),/WORKER NEXT CALL/);await harness.stop();
console.log('LIVE_PERSONA_OK');`;
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',code],{
 cwd:process.cwd(),env:{...process.env,TEST_HOME:home,PI_CODING_AGENT_DIR:home},timeout:90000,maxBuffer:1024*1024});
 assert.match(stdout,/LIVE_PERSONA_OK/);
 } finally {await rm(home,{recursive:true,force:true});}
});
