import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { capabilityContext } from "../src/capability-context.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const context = (sessionKey: string) => capabilityContext({ revision: 0, sessionKey,
  selectedTools: [], registeredTools: [], dispatcherEnabled: false, dispatcherReady: false,
  reviewInstructions: "" });
const check = (text: string) => {
  assert.match(text, /Effective Harness capabilities/);
  assert.doesNotMatch(text, /ALWAYS|KISS|vertical slices|small PRs|required review|do not merge|own PRs|GitOps/i);
};

test("host capabilities impose no default working rules on parents or children", () => {
  for (const key of ["mem:room1", "dispatch:task:claim", "subagent:child"]) check(context(key));
});

test("real PI hook preserves operator persona without injecting a Core workflow", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "operator-persona-pi-"));
  try {
    const code = `
      import assert from 'node:assert/strict';
      import { PiRuntime } from './src/runtime/pi.ts';
      import { capabilityContext } from './src/capability-context.ts';
      const runtime = new PiRuntime({agentDir:process.env.PI_CODING_AGENT_DIR, sessionsDir:process.env.PI_CODING_AGENT_DIR,
        cwd:process.cwd(),personaSections:async()=>['Operator-selected workflow: vertical slices.'],tools:[],approvals:()=>({mode:'off',tools:[]})});
      for (const key of ['mem:parent','dispatch:task:claim','subagent:child']) {
        const wrapped = await runtime.open(key);
        try {
          const session = wrapped.session;
          session.prompt = async text => {
            assert.equal(text,'concrete request');
            const event = await session.extensionRunner.emitBeforeAgentStart(
              {messageType:'user',prompt:text}, {cwd:process.cwd(),tools:[]});
            const prompt = event.systemPromptOptions.appendSystemPrompt;
            assert.match(prompt, /Operator-selected workflow: vertical slices/);
            assert.doesNotMatch(prompt, /ALWAYS KISS|ALWAYS small focused|Do not merge your own/);
            assert.equal(session.messages.length,0);
          };
          await wrapped.prompt('concrete request',{instructions:capabilityContext({revision:0,sessionKey:key,
            selectedTools:[],registeredTools:[],dispatcherEnabled:false,dispatcherReady:false,reviewInstructions:''})});
        } finally {await wrapped.dispose();}
      }
      console.log('OPERATOR_PERSONA_PASSED');`;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: home }, timeout: 30000 });
    assert.match(stdout, /OPERATOR_PERSONA_PASSED/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("ordinary working turns receive capabilities, not unconfigured workflow restrictions", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, capabilityContext: input => context(input.sessionKey) });
  harness.onStateChange = async () => {};
  harness.addChannel(new MemoryChannel());
  try {
    await harness.submit(msg("Implement the requested change")); await harness.drained();
    check(runtime.sessions.get("mem:room1")!.options[0].instructions!);
  } finally { await harness.stop(0); }
});
