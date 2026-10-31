import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { capabilityContext } from "../src/capability-context.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const context = (sessionKey: string) => capabilityContext({ revision: 0, sessionKey,
  selectedTools: [], registeredTools: [], dispatcherEnabled: false, dispatcherReady: false,
  reviewInstructions: "Required review remains mandatory" });
const check = (text: string) => {
  assert.match(text, /ALWAYS vertical slices\. ALWAYS KISS\./);
  assert.match(text, /ALWAYS small focused changes and small PRs: one purpose per PR, independently deployable increments, explicit real dependencies, no batching unrelated fixes or holding ready fixes for unrelated work, and no unusable horizontal fragments; preserve required CI and never treat this rule as automatic rollout permission\./);
  assert.match(text, /persistence, restart, continuation and activation when relevant/);
  assert.match(text, /No speculative abstractions, additional state machines or approval loops/);
  assert.match(text, /Tests, merge and image builds are intermediate evidence, not live completion/);
  assert.match(text, /Preserve safety, authorization and required review/);
  assert.match(text, /not mechanical correctness enforcement/);
  assert.match(text, /Required review remains mandatory/);
};

test("default CLI wiring loads working instructions independently of dispatcher, tools and persona", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /capabilityContext: input => capabilityContext\(\{/);
  for (const key of ["mem:room1", "dispatch:task:claim", "subagent:child"]) check(context(key));
});

test("real PI before_agent_start hook puts rule in system prompt, not user transcript", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vertical-kiss-pi-"));
  try {
    const code = `
      import assert from 'node:assert/strict';
      import { PiRuntime } from './src/runtime/pi.ts';
      import { capabilityContext } from './src/capability-context.ts';
      const runtime = new PiRuntime({agentDir:process.env.PI_CODING_AGENT_DIR, sessionsDir:process.env.PI_CODING_AGENT_DIR,
        cwd:process.cwd(),personaSections:async()=>[],tools:[],approvals:()=>({mode:'off',tools:[]})});
      for (const key of ['mem:parent','dispatch:task:claim','subagent:child']) {
        const wrapped = await runtime.open(key);
        try {
          const session = wrapped.session;
          session.prompt = async text => {
            assert.equal(text,'concrete request');
            const event = await session.extensionRunner.emitBeforeAgentStart(
              {messageType:'user',prompt:text}, {cwd:process.cwd(),tools:[]});
            assert.match(event.systemPromptOptions.forceSystemPrompt, /<run_instructions>[\\s\\S]*ALWAYS vertical slices\\. ALWAYS KISS\\./);
            assert.match(event.systemPromptOptions.forceSystemPrompt, /ALWAYS small focused changes and small PRs: one purpose per PR, independently deployable increments, explicit real dependencies, no batching unrelated fixes or holding ready fixes for unrelated work, and no unusable horizontal fragments; preserve required CI and never treat this rule as automatic rollout permission\./);
            assert.equal(session.messages.length,0);
          };
          await wrapped.prompt('concrete request',{instructions:capabilityContext({revision:0,sessionKey:key,
            selectedTools:[],registeredTools:[],dispatcherEnabled:false,dispatcherReady:false,reviewInstructions:''})});
        } finally {await wrapped.dispose();}
      }
      console.log('SYSTEM_RULE_PASSED');`;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: home }, timeout: 30000 });
    assert.match(stdout, /SYSTEM_RULE_PASSED/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("ordinary parent and real dispatcher bridge propagate rule to runtime prompt options", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vertical-kiss-"));
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000,
    capabilityContext: input => context(input.sessionKey) });
  t.after(async () => { await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  harness.onStateChange = async () => {};
  harness.addChannel(new MemoryChannel());
  const store = new ExecutionStore(path.join(home, "ledger.json")); await store.load();
  const bridge = new DispatcherRuntime(harness, store); harness.addChannel(bridge.channel);
  await harness.submit(msg("Implement the requested slice")); await harness.drained();
  check(runtime.sessions.get("mem:room1")!.options[0].instructions!);
  const task = await store.submit("mem:room1", "request", "Verify the requested slice", "direct");
  const result = await bridge.strategy.execute({ ...task, token: "claim" }, {
    signal: new AbortController().signal, intent: async () => {}, checkpoint: async () => {},
    settleIntent: async () => {},
  });
  assert.match(result, /echo:/);
  check(runtime.sessions.get(`dispatch:${task.id}:claim`)!.options[0].instructions!);
});
