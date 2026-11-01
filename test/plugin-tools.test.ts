import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
test("real PI adapter exposes plugin tools, executes them and respects empty tool selection", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-tools-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import {PiRuntime} from './src/runtime/pi.ts';
const tool={name:'plugin_echo',description:'Echo text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},execute:async(input,ctx)=>ctx.sessionKey+':'+input.text};
for(const tools of [undefined,[],['plugin_echo']]) {
 const runtime=new PiRuntime({cwd:process.env.TEST_HOME,sessionsDir:process.env.TEST_HOME+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},tools,pluginTools:()=>[tool]});
 const wrapped=await runtime.open('fixture');
 try {
  const s=wrapped.session;
  assert.equal(s.getActiveToolNames().includes('plugin_echo'),tools?.length!==0);
  assert.equal(s.settingsManager.getCompactionSettings().enabled,false,'host owns compaction on open');
  const def=s.extensionRunner.getToolDefinition('plugin_echo');
  assert.ok(def);
  const result=await def.execute('call',{text:'hello'},undefined,undefined,{});
  assert.equal(result.content[0].text,'fixture:hello');
 } finally {await wrapped.dispose()}
}
// Real adapter + SDK reload, with only model execution replaced. No network/model call.
for(const tools of [undefined,[],['plugin_echo']]) {
 let catalog=[tool];
 const runtime=new PiRuntime({cwd:process.env.TEST_HOME,sessionsDir:process.env.TEST_HOME+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},tools,pluginTools:()=>catalog});
 const wrapped=await runtime.open('catalog-'+JSON.stringify(tools));
 try {
  const s=wrapped.session;
  s.sessionManager.appendMessage({role:'user',content:'retained history',timestamp:1000});
  await s.reload(); await s.bindExtensions({});
  const history=JSON.stringify(s.messages);
  let prompts=0,reloads=0;
  s.prompt=async()=>{assert.equal(s.settingsManager.getCompactionSettings().enabled,false,'host owns compaction after reload');prompts++;}; s.waitForIdle=async()=>{};
  const reload=s.reload.bind(s);
  s.reload=async()=>{reloads++; await reload();};
  catalog=[{...tool,name:'plugin_new',description:'New catalog tool'}];
  s.settingsManager.applyOverrides({compaction:{enabled:true}});
  await wrapped.prompt('reconcile name');
  assert.equal(reloads,1);
  assert.equal(prompts,1);
  assert.equal(s.getAllTools().some(t=>t.name==='plugin_echo'),false);
  assert.ok(s.extensionRunner.getToolDefinition('plugin_new'),'new definition for selection '+JSON.stringify(tools));
  assert.equal(s.getActiveToolNames().includes('plugin_new'),tools===undefined,'new names do not broaden explicit allowlists');
  if(tools?.length===0) assert.deepEqual(s.getActiveToolNames(),[]);
  assert.equal(JSON.stringify(s.messages),history);
  catalog=[{...tool,parameters:{type:'object',properties:{count:{type:'number'}}}}];
  await wrapped.prompt('reconcile schema');
  assert.equal(reloads,2);
  assert.deepEqual(s.extensionRunner.getToolDefinition('plugin_echo').parameters,catalog[0].parameters);
  assert.equal(s.getActiveToolNames().includes('plugin_echo'),tools?.length!==0);
  assert.equal(JSON.stringify(s.messages),history);
  await wrapped.prompt('unchanged'); assert.equal(reloads,2);
  catalog=[];
  let fail=true;
  s.reload=async()=>{if(fail){fail=false;throw Error('catalog reload failure');} reloads++;await reload();};
  await assert.rejects(wrapped.prompt('failed'),/catalog reload failure/);
  assert.equal(prompts,3,'failed reload blocks model execution');
  await wrapped.prompt('retry');
  assert.equal(s.getAllTools().some(t=>t.name==='plugin_echo'),false);
  assert.equal(JSON.stringify(s.messages),history);
  // Catalog changes during an awaited reload must block, then retry coherently.
  catalog=[tool];
  s.reload=async()=>{reloads++;await reload();catalog=[{...tool,name:'plugin_raced'}];};
  await assert.rejects(wrapped.prompt('raced'),/catalog changed during session reload/);
  assert.equal(prompts,4);
  s.reload=reload;
  await wrapped.prompt('race retry');
  assert.ok(s.extensionRunner.getToolDefinition('plugin_raced'));
  assert.equal(s.getAllTools().some(t=>t.name==='plugin_echo'),false);
  assert.equal(JSON.stringify(s.messages),history);
 } finally {await wrapped.dispose();}
}
console.log('PLUGIN_TOOLS_OK');`;
    const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_HOME: home }, timeout: 30000,
    });
    assert.match(result.stdout, /PLUGIN_TOOLS_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
