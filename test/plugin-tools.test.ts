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
  const def=s.extensionRunner.getToolDefinition('plugin_echo');
  assert.ok(def);
  const result=await def.execute('call',{text:'hello'},undefined,undefined,{});
  assert.equal(result.content[0].text,'fixture:hello');
 } finally {wrapped.dispose()}
}
console.log('PLUGIN_TOOLS_OK');`;
    const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_HOME: home }, timeout: 30000,
    });
    assert.match(result.stdout, /PLUGIN_TOOLS_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
