// Opt-in real-model diagnostic, not part of CI and not a production timeout policy.
// Run: HAYATE_PROBE_BASE_URL=http://host:port/v1 HAYATE_PROBE_MODEL=model-id \
//      node --import tsx scripts/probe-task-context.mts
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PiRuntime} from '../src/runtime/pi.js';
import {personaSections} from '../src/persona.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {RequestActivity} from './request-activity.mjs';

const baseUrl=process.env.HAYATE_PROBE_BASE_URL, modelId=process.env.HAYATE_PROBE_MODEL;
if(!baseUrl||!modelId) throw Error('Explicit HAYATE_PROBE_BASE_URL and HAYATE_PROBE_MODEL required; no automatic model choice');
const root=process.env.HAYATE_PROBE_OUTPUT??os.tmpdir();
await mkdir(root,{recursive:true,mode:0o700});
const out=await mkdtemp(path.join(root,'hayate-context-probe-'));
const home=path.join(out,'runtime');await mkdir(home,{mode:0o700});
process.env.HOME=home;process.env.PI_CODING_AGENT_DIR=path.join(home,'agent');
const probeId='context-'+randomUUID();
const models=await ModelRuntime.create({authPath:path.join(home,'auth.json'),modelsPath:null,modelsStorePath:path.join(home,'models-store.json'),refreshOnCreate:false});
models.registerProvider('context-proof',{api:'openai-completions',baseUrl,apiKey:process.env.HAYATE_PROBE_API_KEY??'local',headers:{'User-Agent':'hayate-maintenance/1.0'},
 models:[{id:modelId,name:'Explicit probe model',reasoning:false,input:['text'],contextWindow:262144,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
let effects=0;
const evidence='Synthetic read-only fixture.\n'+'NORMAL: fixture service is running.\n'.repeat(1200)+'ERROR: fixture backup checksum mismatch; no repair or write was attempted.\n';
const runtime=new PiRuntime({cwd:home,sessionsDir:path.join(home,'sessions'),model:'context-proof/'+modelId,skillPaths:[],tools:['plugin_probe','read'],
 personaSections:async(cwd,worker)=>personaSections({soul:'Analyze only synthetic maintenance evidence. Do not change services or files.',overlays:[{name:'MEMORY.md',text:'Unrelated old synthetic history. '.repeat(1000)}]},{name:'context-proof',workspace:cwd,worker}),
 reasoningEffortNoneModels:()=>['context-proof/'+modelId],approvals:{mode:'off',tools:[]},pluginTools:()=>[{name:'plugin_probe',description:'Read the synthetic fixture once; no external effect.',parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{effects++;return evidence;}}]});
(runtime as any).modelRuntime=async()=>models;
const session:any=await runtime.open('dispatch:synthetic:'+probeId);
const calls:any[]=[];
let active:any;
const original=session.session.agent.streamFunction;
const idleMs=process.env.LIVE_MODEL_IDLE_MS===undefined?undefined:Number(process.env.LIVE_MODEL_IDLE_MS);
if(idleMs!==undefined&&(!Number.isSafeInteger(idleMs)||idleMs<1000)) throw Error('Invalid explicit LIVE_MODEL_IDLE_MS');
const log=(value:Record<string,unknown>)=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
session.session.agent.streamFunction=(model:any,context:any,options:any)=>{
 const id=probeId+'-'+(calls.length+1),activity=new RequestActivity(id);
 const record:any={id,activity,projectionBytes:Buffer.byteLength(JSON.stringify(context))};
 calls.push(record);active=record;
 const tracedFetch:typeof fetch=async(input,init)=>{
  const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;
  if(body){
   record.payloadBytes=Buffer.byteLength(init!.body as string);record.messages=body.messages?.length;
   record.tools=body.tools?.map((tool:any)=>tool.function?.name);record.reasoningEffort=body.reasoning_effort;
   // Only this isolated synthetic fixture is persisted; never log auth headers.
   await writeFile(path.join(out,id+'.payload.json'),JSON.stringify(body),{mode:0o600});
   log({event:'request-sent',id,projectionBytes:record.projectionBytes,payloadBytes:record.payloadBytes,messages:record.messages,tools:record.tools,reasoningEffort:record.reasoningEffort});
  }
  const response=await fetch(input,init);activity.headers(response.status);
  log({event:'response-headers',...activity.snapshot()});
  if(!response.body) return response;
  const decoder=new TextDecoder();let pending='';
  const bodyStream=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
   transform(chunk,controller){
    activity.transport();pending+=decoder.decode(chunk,{stream:true});let end;
    while((end=pending.indexOf('\n'))>=0){
     const line=pending.slice(0,end).trimEnd();pending=pending.slice(end+1);
     if(line.startsWith('data:')){
      const value=line.slice(5).trim();
      if(value&&value!=='[DONE]') try {const frame=JSON.parse(value);activity.frame(frame);record.responseId??=frame.id;} catch { /* Not a JSON delta. */ }
     }
    }
    controller.enqueue(chunk);
   },
   flush(){activity.finish();log({event:'response-finished',...activity.snapshot()});},
  }));
  return new Response(bodyStream,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
 const streamed=original(model,context,{...options,fetch:tracedFetch,onPayload:async(payload:any,selected:any)=>{
  const rewritten=await options?.onPayload?.(payload,selected);
  const body=rewritten??payload;
  return process.env.HAYATE_PROBE_VLLM==='1'?{...body,request_id:id,return_token_ids:true}:body;
 }});
 void Promise.resolve(streamed).then(stream=>stream.result()).then(message=>{
  activity.finish();record.stop=message.stopReason;record.usage=message.usage;
  log({event:'provider-result',id,stop:message.stopReason,providerError:!!message.errorMessage,usage:message.usage});
 });
 return streamed;
};
// Report activity; there is no fixed overall deadline. Before the first own
// delta queue/prefill is unknown, and global backend load cannot authorize abort.
const reporter=setInterval(()=>{
 if(!active) return;
 log({event:'activity',...active.activity.snapshot()});
 if(idleMs!==undefined&&active.activity.inactive(idleMs)){
  log({event:'explicit-observed-inactivity-policy',idleMs,...active.activity.snapshot()});void session.abort();
 }
},10000);
const cancel=()=>{log({event:'operator-cancel'});void session.abort();};
process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
log({event:'probe-start',probeId,pid:process.pid,output:out,overallDeadline:null,explicitObservedIdleMs:idleMs??null});
try {
 const answer=await session.prompt('Call plugin_probe exactly once, inspect its evidence, and report the finding in at most three short bullets. Do not reproduce normal log lines. Include whether any repair occurred and the full-evidence reference. Use read only if needed; no other operations.',{thinking:'off'});
 const requests=calls.map(({activity,...record})=>({...record,...activity.snapshot()}));
 const result={probeId,effects,replyChars:answer.length,requests,reply:answer};
 await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
 assert.equal(effects,1,'expected exactly one fixture tool invocation');
 assert(answer.length>0&&answer.length<3000);assert.match(answer,/checksum|Prüfsumme/i);
 assert(calls.length>=2&&calls.length<=5);
 assert(calls[1].projectionBytes<evidence.length/2,'raw output is absent from next request');
 log({event:'probe-passed',...result});
} finally {
 clearInterval(reporter);process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);
 await session.dispose();log({event:'diagnostic-artifacts-retained',home});
}
