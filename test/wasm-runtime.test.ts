// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("Wasm tools use SDK approval hooks and explicit tool selection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),"wasm-runtime-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import { PiRuntime } from './src/runtime/pi.ts';
import { wasmTools } from './src/wasm-tools.ts';
// Deliberately absent module: denied calls must not reach the module reader.
const tools=wasmTools(process.env.TEST_DIR,[{name:'plugin_transform',description:'Transform',path:'missing.wasm'}]);
let approvals=0,guardCalls=0;
const runtime=new PiRuntime({cwd:process.env.TEST_DIR,sessionsDir:process.env.TEST_DIR+'/sessions',skillPaths:[],personaSections:async()=>[],pluginTools:()=>tools,tools:['plugin_transform'],approvals:{mode:'manual',tools:['plugin_transform']},requestApproval:async()=>{approvals++;return false;},toolGuard:async()=>{guardCalls++;}});
const wrapped=await runtime.open('test');
try {
 const s=wrapped.session;
 assert.deepEqual(s.getActiveToolNames(),['plugin_transform']);
 const event={type:'tool_call',toolName:'plugin_transform',toolCallId:'test',input:{input:'x'}};
 const denied=await s.extensionRunner.emitToolCall(event);
 assert.equal(denied.block,true); assert.equal(approvals,1); assert.equal(guardCalls,1);
 await runtime.reload(); s.prompt=async()=>{};s.waitForIdle=async()=>{}; await wrapped.prompt('reload');
 assert.deepEqual(s.getActiveToolNames(),['plugin_transform']);
 assert.equal((await s.extensionRunner.emitToolCall(event)).block,true);
 assert.equal(approvals,2);
} finally {await wrapped.dispose();}
const disabled=await new PiRuntime({cwd:process.env.TEST_DIR,sessionsDir:process.env.TEST_DIR+'/sessions',skillPaths:[],personaSections:async()=>[],pluginTools:()=>tools,tools:[],approvals:{mode:'off',tools:[]}}).open('disabled');
try { assert.deepEqual(disabled.session.getActiveToolNames(),[]); } finally {await disabled.dispose();}
console.log('GUARDS_PASSED');
`;
    const { stdout } = await promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:process.cwd(),env:{...process.env,PI_CODING_AGENT_DIR:dir,TEST_DIR:dir},timeout:15000});
    assert.match(stdout,/GUARDS_PASSED/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
