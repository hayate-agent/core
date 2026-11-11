import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Harness } from "../src/harness.js";
import { Dispatcher } from "../src/dispatcher.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import { Subagents } from "../src/subagents.js";
import { capabilityContext } from "../src/capability-context.js";
import { childDeniedTools, CHILD_OUTCOME_CONTRACT } from "../src/child-tools.js";
import { toolGuardDenialReason } from "../src/tool-guard-error.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const exec = promisify(execFile);

test("child contract: workers lose parent-owned orchestration tools, main keeps continuation", () => {
  assert.deepEqual(childDeniedTools("mem:room1"), []);
  for (const key of ["dispatch:a:b", "subagent:c"]) {
    assert.ok(childDeniedTools(key).includes("plugin_task_continuation"));
    assert.ok(childDeniedTools(key).includes("plugin_loop"));
    assert.ok(childDeniedTools(key).includes("plugin_subagent"));
  }
  assert.ok(childDeniedTools("dispatch:a:b").includes("plugin_dispatch"));
  assert.ok(childDeniedTools("dispatch:a:b").includes("plugin_worker_tasks"));
  const facts = { revision: 1, selectedTools: undefined, registeredTools: ["plugin_dispatch", "plugin_subagent"],
    dispatcherEnabled: true, dispatcherReady: true, reviewInstructions: "" };
  const data = (text: string) => JSON.parse(text.slice(text.indexOf("{")).split("\n")[0]!);
  assert.equal(data(capabilityContext({ ...facts, sessionKey: "mem:room1" })).dispatcher.exposed, true);
  assert.equal(data(capabilityContext({ ...facts, sessionKey: "dispatch:a:b" })).dispatcher.exposed, false);
  assert.equal(data(capabilityContext({ ...facts, sessionKey: "subagent:c" })).subagent.exposed, false);
});

test("real PI adapter hides denied tools from workers for default and explicit tool selections, across reload", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "worker-tools-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import {PiRuntime} from './src/runtime/pi.ts';
const mk=name=>({name,description:name,parameters:{type:'object',properties:{}},execute:async()=>'ok'});
let catalog=['plugin_task_continuation','plugin_loop','plugin_subagent','plugin_dispatch','plugin_worker_tasks','plugin_improvement_evaluate','plugin_memory'].map(mk);
for(const tools of [undefined,['read','bash','plugin_task_continuation','plugin_loop','plugin_subagent','plugin_dispatch','plugin_worker_tasks','plugin_improvement_evaluate','plugin_memory']]) {
 const runtime=new PiRuntime({cwd:process.env.TEST_HOME,sessionsDir:process.env.TEST_HOME+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},tools,pluginTools:()=>catalog});
 for(const [key,hidden,visible] of [
   ['main',[],['read','bash','plugin_task_continuation','plugin_loop','plugin_dispatch','plugin_memory']],
   ['dispatch:x:y',['plugin_task_continuation','plugin_loop','plugin_subagent','plugin_dispatch','plugin_worker_tasks','plugin_improvement_evaluate'],['plugin_memory','read','bash']],
   ['subagent:z',['plugin_task_continuation','plugin_loop','plugin_subagent','plugin_improvement_evaluate'],['plugin_memory','plugin_dispatch','read']],
 ]) {
  const wrapped=await runtime.open(key);
  try {
   const s=wrapped.session;
   const check=()=>{const active=s.getActiveToolNames();
    for(const n of hidden) assert.equal(active.includes(n),false,key+' must not see '+n+' tools='+JSON.stringify(tools));
    for(const n of visible) assert.equal(active.includes(n),true,key+' must see '+n+' tools='+JSON.stringify(tools));};
   check();
   // Catalog change forces SDK reload; exclusion must survive it.
   catalog=[...catalog.slice(0,-1),{...mk('plugin_memory'),description:'changed'+key+tools?.length}];
   s.agent.streamFn=async()=>{throw Error('no model call in test')};
   try{await wrapped.prompt('x')}catch{}
   check();
  } finally {await wrapped.dispose()}
 }
}
console.log('WORKER_TOOLS_OK');`;
    const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_HOME: home }, timeout: 60000,
    });
    assert.match(result.stdout, /WORKER_TOOLS_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("worker gets outcome contract, not continuation instructions; parent keeps continuation context", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue" });
  harness.onStateChange = async () => {};
  try {
    for (const key of ["main", "dispatch:a:b", "subagent:c"]) {
      await harness.accept({ id: `in-${key}`, sessionKey: key, source: "api", text: "work" });
      await harness.waitForSessionIdle(key);
    }
    const instr = (key: string) => runtime.sessions.get(key)!.options.at(-1)!.instructions ?? "";
    assert.match(instr("main"), /Task continuation allowance/);
    assert.match(instr("main"), /Continuation scope:/);
    for (const key of ["dispatch:a:b", "subagent:c"]) {
      assert.ok(instr(key).includes(CHILD_OUTCOME_CONTRACT), key);
      assert.doesNotMatch(instr(key), /Task continuation allowance|Continuation scope:/, key);
    }
  } finally { await harness.stop(0); }
});

test("guard: unknown worker sessions stay denied, main sessions keep continuation", async () => {
  const store = new ExecutionStore(path.join(await mkdtemp(path.join(os.tmpdir(), "guard-")), "l.json")); await store.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const bridge = new DispatcherRuntime(harness, store);
  const subagents = new Subagents(harness, async () => {});
  // A live worker attempt is denied with worker_orchestration_denied in the end-to-end test below.
  assert.throws(() => bridge.guardTool("dispatch:none:none", "plugin_task_continuation"), /authorized/);
  assert.doesNotThrow(() => bridge.guardTool("main", "plugin_task_continuation"));
  assert.doesNotThrow(() => subagents.guardTool("main", "plugin_task_continuation"));
  await harness.stop(0);
});

test("worker that ignores the contract still delivers a nonempty result; parent validator plans next", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "worker-contract-e2e-"));
  const store = new ExecutionStore(path.join(home, "ledger.json")); await store.load();
  const runtime = new FakeRuntime();
  let bridge!: DispatcherRuntime; let dispatcher!: Dispatcher;
  const denials: string[] = []; const assessed: string[] = [];
  const harness = new Harness({ runtime, executionStore: store, tickMs: 60000, busyMode: "queue",
    beforeExecution: input => bridge.beforeTurn(input.sessionKey),
    hostEventAllowed: input => !!input.hostEvent && bridge.resultAllowed(input.sessionKey, input.hostEvent.executionId),
    completionCheck: async (input, reply) => {
      if (input.source !== "host") return { state: "waiting" };
      assessed.push(reply);
      return { state: "continue", next: "Run the regression suite" };
    },
  });
  harness.onStateChange = async () => {};
  const replies = new MemoryChannel(); harness.addChannel(replies);
  bridge = new DispatcherRuntime(harness, store); harness.addChannel(bridge.channel);
  let delivered!: () => void; const received = new Promise<void>(resolve => { delivered = resolve; });
  dispatcher = new Dispatcher(store, bridge.strategy, 1, async event => {
    if (event.type !== "result") return;
    await harness.accept({ id: `dispatch-event:${event.id}`, sessionKey: event.parent, source: "host",
      hostEvent: { executionId: event.executionId }, text: event.text, replyTo: { channel: replies.name, target: "operator" } });
    delivered();
  }, () => {}, parent => harness.dependencyCheckpoint(parent));
  t.after(async () => { await dispatcher.stop(); await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  let task!: Awaited<ReturnType<Dispatcher["submit"]>>;
  runtime.answer = async (text, key) => {
    if (!key.startsWith("dispatch:")) {
      // Delegate inside the owning turn, while its host mandate is active.
      // Submission after idle has no current-turn provenance and must not rely
      // on resultMandate adopting the focused task later.
      if (text === "Fix it; tests only") task = await dispatcher.submit("main", "req", "implement fix");
      return `parent: ${text.slice(0, 40)}`;
    }
    // A worker model that still tries the parent's continuation tool, as in the live evidence.
    try { bridge.guardTool(key, "plugin_task_continuation"); } catch (error) { denials.push(toolGuardDenialReason(error)); }
    return "worker evidence: fix implemented and tested";
  };
  await dispatcher.start();
  await harness.accept({ id: "op", sessionKey: "main", source: "channel", text: "Fix it; tests only", replyTo: { channel: replies.name, target: "operator" } });
  await harness.waitForSessionIdle("main");
  await received; await harness.waitForSessionIdle("main");
  assert.equal(denials.length, 1);
  assert.match(denials[0]!, /^worker_orchestration_denied/);
  const done = store.list().find(item => item.id === task.id)!;
  assert.equal(done.status, "completed");
  assert.equal(done.result, "worker evidence: fix implemented and tested");
  const parentPrompts = runtime.sessions.get("main")!.prompts;
  assert.ok(parentPrompts.includes("worker evidence: fix implemented and tested"), "parent received the nonempty worker result");
  assert.ok(parentPrompts.some(text => /Run the regression suite/.test(text)), "validator-admitted next step executed by the parent");
  assert.equal(assessed.length, 1, "independent validator assessed the host result once");
  assert.equal(replies.texts().some(text => /cannot close|nicht abschlie/i.test(text)), false);
  const parentTask = harness.sessions.get("main")!.task!;
  assert.ok(parentTask.state !== "blocked", `parent task not falsely blocked: ${parentTask.state}`);
});
