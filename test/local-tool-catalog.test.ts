import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiRuntime } from '../src/runtime/pi.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

test('real SDK local tool schemas are deferred/discoverable, restrictions preserved; native compaction uses small budget',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'local-tool-catalog-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const models=await ModelRuntime.create();models.registerProvider('local-fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:['model','frontier'].map(id=>({id,name:'Fixture',api:'openai-completions',reasoning:false,input:['text'],contextWindow:262144,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))});
 const pluginTools=()=>Array.from({length:30},(_,i)=>({name:'plugin_large_'+i,description:'Large fixture '+i,parameters:{type:'object',properties:{input:{type:'string',description:'metadata'.repeat(1000)}}},execute:async()=> 'no effects'}));
 const steps:Array<{key:string;id:string;reply:string;tools:number;failed:boolean}>=[];
 const options={captureStep:async(key:string,step:any)=>{steps.push({key,...step});},cwd:home,sessionsDir:path.join(home,'sessions'),skillPaths:[],model:'local-fixture/model',personaSections:async()=>[],pluginTools,
  contextBudgets:()=>({mainContextTokens:262144,workerContextTokens:131072,localModels:['local-fixture/model']}),approvals:{mode:'off' as const,tools:[]}};
 const runtime=new PiRuntime(options);(runtime as any).modelRuntime=async()=>models;
 const wrapped:any=await runtime.open('matrix:fixture');const session=wrapped.session;
 try{
  assert.ok(session.getActiveToolNames().includes('tool_search'));assert.ok(!session.getActiveToolNames().includes('plugin_large_0'));
  const all=session.getAllTools();assert.ok(all.some((tool:any)=>tool.name==='plugin_large_0'&&tool.exposure==='deferred'));
  const before=JSON.stringify(all.filter((tool:any)=>session.getActiveToolNames().includes(tool.name)).map((tool:any)=>tool.parameters)).length;
  const total=JSON.stringify(all.map((tool:any)=>tool.parameters)).length;assert.ok(before<total/4);
  await session.getToolDefinition('tool_search').execute('lookup',{query:'plugin_large_7',limit:1});
  assert.ok(session.getActiveToolNames().some((name:string)=>name.startsWith('plugin_large_')));
  // A completed effect must retain its original result even if artifact mkdir fails.
  await writeFile(path.join(home,'sessions','tool-results'),'blocked directory');
  const failedRetention=await session.extensionRunner.emitToolResult({type:'tool_result',toolCallId:'completed-effect',toolName:'write',input:{path:'fixture'},content:[{type:'text',text:'completed write '+ 'e'.repeat(5000)}],isError:false});
  assert.equal(failedRetention,undefined);await rm(path.join(home,'sessions','tool-results'));
  await session.extensionRunner.emit({type:'turn_end',turnIndex:0,messageEntryId:'native-step',toolResultEntryIds:['native-result'],
    message:{role:'assistant',content:[{type:'text',text:'Reported prior result; verify before next effect'}],stopReason:'toolUse'},
    toolResults:[{role:'toolResult',toolCallId:'native-call',toolName:'read',isError:false,content:[{type:'text',text:'untrusted evidence'}]}]});
  assert.equal(steps.length,1);assert.equal(steps[0]!.key,'matrix:fixture');assert.equal(steps[0]!.tools,1);assert.match(steps[0]!.reply,/native-step/);assert.match(steps[0]!.reply,/not independent verification/);
  const original='tool data '+ '🙂 evidence '.repeat(2000);
  const projected=await session.extensionRunner.emitToolResult({type:'tool_result',toolCallId:'large-read',toolName:'read',input:{path:'fixture'},content:[{type:'text',text:original}],isError:false,structuredContent:{receipt:'unchanged'}});
  assert.ok(projected.content[0].text.length<4000);assert.deepEqual(projected.structuredContent,{receipt:'unchanged'});
  const match=/Complete original at (.*?); sha256=([a-f0-9]{64})/.exec(projected.content[0].text)!;assert.ok(match);assert.equal(await readFile(match[1]!,'utf8'),original);
  const view=match[1]!.replace(/\.txt$/,'.lines.txt');assert.equal((await readFile(view,'utf8')).split('\n').join(''),original);
  session.prompt=async()=>{const settings=session.settingsManager.getCompactionSettings(session.model);assert.equal(settings.enabled,true);assert.ok(session.model.contextWindow-settings.reserveTokens<=16384);};session.waitForIdle=async()=>{};
  await wrapped.prompt('metadata-only offline fixture');const status=wrapped.status();assert.equal(status.contextBudgetTokens,16384);assert.ok(status.contextEstimateTokens>0);
 }finally{await wrapped.dispose();}
 const mixed=new PiRuntime({...options,model:'local-fixture/frontier'});(mixed as any).modelRuntime=async()=>models;
 const frontier:any=await mixed.open('matrix:frontier');assert.equal(frontier.session.getActiveToolNames().filter((name:string)=>name.startsWith('plugin_large_')).length,30);
 frontier.session.waitForIdle=async()=>{};
 frontier.session.prompt=async()=>{assert.equal(frontier.session.getActiveToolNames().filter((name:string)=>name.startsWith('plugin_large_')).length,0);};
 await frontier.setModel('local-fixture/model');await frontier.prompt('local switch');
 frontier.session.prompt=async()=>{assert.equal(frontier.session.getActiveToolNames().filter((name:string)=>name.startsWith('plugin_large_')).length,30);};
 await frontier.setModel('local-fixture/frontier');await frontier.prompt('frontier switch');await frontier.dispose();
 const restricted=new PiRuntime({...options,tools:[]});(restricted as any).modelRuntime=async()=>models;
 const noTools:any=await restricted.open('matrix:restricted');assert.deepEqual(noTools.session.getActiveToolNames(),[]);await noTools.dispose();
});
