import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PiRuntime} from '../src/runtime/pi.js';
test('agent ownership survives reload and oversized plugin result is bounded before ingress with original retained',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'plugin-ingress-'));
 let owner:'agent'|'harness'='agent';
 const original='raw-evidence\n'.repeat(200000);
 const runtime=new PiRuntime({cwd:home,sessionsDir:path.join(home,'sessions'),skillPaths:[],personaSections:async()=>[],compactionOwner:()=>owner,approvals:{mode:'off',tools:[]},pluginTools:()=>[{name:'plugin_large',description:'large fixture',parameters:{type:'object',properties:{}},execute:async()=>original}]});
 try{
 const wrapped:any=await runtime.open('private-conversation'),s=wrapped.session;
 assert.equal(s.settingsManager.getCompactionSettings().enabled,true);
 const result=await s.extensionRunner.getToolDefinition('plugin_large').execute('call',{},new AbortController().signal,undefined,{});
 assert.equal(result.content[0].text,original,'programmatic/nested tool callers can filter the full result');
 const projected=await s.extensionRunner.emitToolResult({type:'tool_result',toolCallId:'call',toolName:'plugin_large',input:{},...result,isError:false});
 const text=projected.content[0].text;assert.ok(text.length<4000);assert.match(text,/not a complete summary or proof of success/);
 const file=text.match(/Complete original at (.*?); sha256/)[1];assert.equal(await readFile(file,'utf8'),original);
 s.prompt=async()=>{assert.equal(s.settingsManager.getCompactionSettings().enabled,owner==='agent');};s.waitForIdle=async()=>{};
 s.settingsManager.applyOverrides({compaction:{enabled:false}});await wrapped.prompt('agent');owner='harness';await wrapped.prompt('harness');await wrapped.dispose();
 }finally{await rm(home,{recursive:true,force:true});}
});
