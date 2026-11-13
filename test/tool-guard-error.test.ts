import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ToolGuardError, toolGuardDenialReason } from "../src/tool-guard-error.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Subagents } from "../src/subagents.js";

function denial(fn: () => void, code: string) {
  assert.throws(fn, error => {
    assert.match(toolGuardDenialReason(error), new RegExp(`^${code}:`));
    return true;
  });
}

test("guard throw sites classify orchestration and revoked authority", () => {
  const task = { id: "id", token: "token", status: "running", parentStopped: false };
  const worker = new DispatcherRuntime({} as never, { list: () => [task] } as never);
  denial(() => worker.guardTool("dispatch:id:token", "plugin_loop"), "worker_orchestration_denied");
  assert.doesNotThrow(() => worker.guardTool("dispatch:id:token", "read"));
  task.parentStopped = true;
  denial(() => worker.guardTool("dispatch:id:token", "read"), "execution_cancelled");
  denial(() => worker.guardResult("parent", "id"), "execution_cancelled");
  task.parentStopped = false;
  task.status = "cancelled";
  denial(() => worker.guardTool("dispatch:id:token", "read"), "execution_cancelled");
  for (const status of ["ready", "running", "paused", "blocked", "failed"]) {
    task.status = status;
    denial(() => worker.guardResult("parent", "id"), "result_not_ready");
  }
  task.status = "failed";
  denial(() => worker.guardTool("dispatch:id:token", "read"), "ownership_lost");
  task.status = "completed";
  assert.doesNotThrow(() => worker.guardResult("parent", "id"));
  denial(() => worker.guardResult("parent", "absent"), "parent_mandate_missing");
  denial(() => worker.guardTool("dispatch:id:stale-token", "read"), "ownership_lost");
  const children = new Subagents({} as never, async () => {});
  const record = { sessionKey: "subagent:child", state: "running", expiresAt: Date.now() + 60_000 };
  (children as any).records.set("child", record);
  denial(() => children.guardTool(record.sessionKey, "plugin_loop"), "worker_orchestration_denied");
  record.expiresAt = 0;
  denial(() => children.guardTool(record.sessionKey, "read"), "deadline_expired");
  record.expiresAt = Date.now() + 60_000;
  record.state = "cancelled";
  denial(() => children.guardTool(record.sessionKey, "read"), "execution_cancelled");
  record.state = "completed";
  denial(() => children.guardTool(record.sessionKey, "read"), "authority_revoked");
  denial(() => children.guardTool("subagent:absent", "read"), "ownership_lost");
});

test("classification never reads arbitrary error properties or exposes messages", () => {
  const unknown = "Tool guard blocked this action; authorization could not be established.";
  const hostile = new Proxy({}, { get() { throw Error("secret"); }, getPrototypeOf() { throw Error("secret"); } });
  for (const error of [Error("secret"), "secret", null, undefined, hostile,
    { code: "review_required", message: "secret" }, Object.create(ToolGuardError.prototype)]) {
    assert.equal(toolGuardDenialReason(error), unknown);
  }
  const known = new ToolGuardError("authority_revoked", "secret");
  Object.defineProperty(known, "message", { get() { throw Error("secret"); } });
  assert.match(toolGuardDenialReason(known), /^authority_revoked:/);
  assert.doesNotMatch(toolGuardDenialReason(known), /secret|review/i);
});

test("PI tool-call guard denials stop approval and actual tool execution with sanitized reasons", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tool-guard-runtime-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import { PiRuntime } from './src/runtime/pi.ts';
import { ToolGuardError } from './src/tool-guard-error.ts';
import { runToolCall } from '@earendil-works/pi-agent-core';
let approvals=0, executions=0, failure;
const tool={name:'plugin_probe',description:'Probe',parameters:{type:'object',properties:{}},execute:async()=>{executions++;return 'executed';}};
const runtime=new PiRuntime({cwd:process.env.TEST_DIR,sessionsDir:process.env.TEST_DIR+'/sessions',skillPaths:[],personaSections:async()=>[],pluginTools:()=>[tool],tools:['plugin_probe'],approvals:{mode:'manual',tools:[]},requestApproval:async()=>{approvals++;return true;},toolGuard:async()=>{if(failure!==undefined)throw failure;}});
const wrapped=await runtime.open('test');
try {
 const s=wrapped.session;
 const toolCall={type:'toolCall',name:'plugin_probe',id:'probe',arguments:{}};
 const call=()=>runToolCall(toolCall,{tools:[{...tool,execute:async()=>{executions++;return {content:[{type:'text',text:'executed'}]};}}],context:{messages:[]},assistantMessage:{role:'assistant',content:[toolCall]},beforeToolCall:s.agent.beforeToolCall});
 for(const code of ['review_required','worker_orchestration_denied','authority_revoked','result_not_ready','dispatcher_unavailable','deadline_expired','execution_cancelled','ownership_lost','parent_mandate_missing']) {
  failure=new ToolGuardError(code,'SECRET arbitrary internal detail');
  const result=await call();
  assert.equal(result.isError,true);
  const text=JSON.stringify(result.result);
  assert.match(text,new RegExp(code+':'));
  assert.doesNotMatch(text,/SECRET/);
  if(code!=='review_required') assert.doesNotMatch(text,/Core review|review_required/);
  assert.equal(approvals,0); assert.equal(executions,0);
 }
 for(const error of [Error('SECRET'),{code:'review_required',message:'SECRET'},'SECRET',null,new Proxy({},{get(){throw Error('SECRET')}})]) {
  failure=error;
  const result=await call();
  assert.equal(result.isError,true);
  assert.match(JSON.stringify(result.result),/authorization could not be established/);
  assert.doesNotMatch(JSON.stringify(result.result),/SECRET|review/i);
  assert.equal(approvals,0); assert.equal(executions,0);
 }
 failure=undefined;
 assert.equal((await call()).isError,false);
 assert.equal(approvals,1); assert.equal(executions,1);
} finally {await wrapped.dispose();}
console.log('GUARD_DENIALS_PASSED');
`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: dir, TEST_DIR: dir }, timeout: 20000,
    });
    assert.match(stdout, /GUARD_DENIALS_PASSED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
