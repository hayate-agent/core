import assert from "node:assert/strict";
import { test } from "node:test";
import { PiSession, toTurnEvent, boundedMaintenance } from "../src/runtime/pi.js";

const A = { provider: "p", id: "a" };
const B = { provider: "p", id: "b" };

/** Minimal stand-in for PI's AgentSession (only what PiSession touches). */
function fakeAgentSession() {
  const s = {
    model: A as unknown,
    thinkingLevel: "high",
    messages: [] as unknown[],
    prompts: [] as string[],
    failSetModel: (_m: unknown) => false,
    gate: undefined as Promise<void> | undefined,
    async setModel(m: unknown) {
      if (s.gate) await s.gate;
      if (s.failSetModel(m)) throw new Error("setModel failed");
      s.model = m;
      if (m === B) s.thinkingLevel = "off"; // model B has no reasoning: PI clamps
    },
    setThinkingLevel(l: string) {
      s.thinkingLevel = s.model === B ? "off" : l;
    },
    subscribe: () => () => {},
    last: "",
    async prompt(text: string) {
      s.prompts.push(text);
      s.last = `ran on ${(s.model as { id: string }).id}`;
      s.messages.push({ role: "assistant", stopReason: "stop", content: [] });
    },
    async waitForIdle() {},
    async abort() {},
    abortCompaction() {},
    getLastAssistantText: () => s.last,
  };
  return s;
}
const models = { getModel: (_p: string, id: string) => (id === "a" ? A : id === "b" ? B : undefined) };

function make() {
  const agent = fakeAgentSession();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = new PiSession(agent as any, models as any, {});
  return { agent, session };
}

test("maintenance deadline aborts compaction and rejects instead of hanging", async () => {
  let aborted = 0;
  await assert.rejects(boundedMaintenance(() => new Promise(() => {}), () => { aborted++; }, 10), /deadline/);
  assert.equal(aborted, 1);
});

test("explicit off supplies reasoning_effort none and restores model metadata", async () => {
  const agent = fakeAgentSession();
  const local = { provider: "local", id: "reasoner", api: "openai-completions", reasoning: true };
  agent.model = local;
  let sampled: unknown;
  agent.prompt = async () => { sampled = agent.model; agent.last = "{}"; };
  const session = new PiSession(agent as never, models as never, {}, undefined, undefined, undefined, undefined, undefined, () => ["local/reasoner"]);
  await session.prompt("JSON", { thinking: "off" });
  assert.equal((sampled as any).samplingParamsByThinkingLevel.off.reasoning_effort, "none");
  assert.equal(agent.model, local);
});

test("off does not inject unsupported none into models without explicit opt-in", async () => {
  const agent = fakeAgentSession();
  const model = { provider: "openai", id: "o3-mini", api: "openai-completions", reasoning: true };
  agent.model = model;
  let sampled: unknown;
  agent.prompt = async () => { sampled = agent.model; agent.last = "{}"; };
  const session = new PiSession(agent as never, models as never, {}, undefined, undefined, undefined, undefined, undefined, () => ["local/reasoner"]);
  await session.prompt("JSON", { thinking: "off" });
  assert.equal(sampled, model);
  assert.equal((sampled as any).samplingParamsByThinkingLevel, undefined);
});

test("PiSession abort also interrupts compaction outside a streaming prompt", async () => {
  const agent = fakeAgentSession(); let aborted = 0;
  agent.abortCompaction = () => { aborted++; };
  const session = new PiSession(agent as never, models as never, {});
  await session.abort(); assert.equal(aborted, 1);
});

test("PiSession: refreshes context before every prompt without replacing the session", async () => {
  const agent = fakeAgentSession();
  let refreshes = 0;
  const session = new PiSession(agent as never, models as never, {}, undefined, undefined, undefined, async () => { refreshes++; });
  await session.prompt("first");
  await session.prompt("second");
  assert.equal(refreshes, 2);
  assert.deepEqual(agent.prompts, ["first", "second"]);
});

test("PiSession: authorization is rechecked after runtime preparation", async () => {
  const agent = fakeAgentSession();
  let expired = false;
  const session = new PiSession(agent as never, models as never, {}, undefined, undefined, undefined, async () => { expired = true; });
  await assert.rejects(session.prompt("expired", { beforeExecution: () => {
    assert.equal(expired, true);
    throw Error("authorization expired");
  } }), /authorization expired/);
  assert.deepEqual(agent.prompts, []);
});

test("PiSession: explicit session selections acknowledge defaults, per-turn overrides do not", async () => {
  const agent = fakeAgentSession();
  let selections = 0;
  const session = new PiSession(agent as any, models as any, {}, undefined, undefined, undefined, undefined, () => { selections++; });
  await session.setModel("p/a");
  session.setThinking("medium");
  assert.equal(selections, 2);
  await session.prompt("override", { model: "p/b", thinking: "low" });
  assert.equal(selections, 2, "temporary API overrides must not acknowledge global revisions");
});

test("PiSession: abort during override setup prevents the prompt from starting", async () => {
  const { agent, session } = make();
  let release!: () => void;
  agent.gate = new Promise((r) => (release = r));
  const running = session.prompt("work", { model: "p/b" });
  await new Promise((r) => setImmediate(r));
  await session.abort();
  agent.gate = undefined;
  release();
  assert.equal(await running, "");
  assert.deepEqual(agent.prompts, []);
  assert.equal(agent.model, A, "override undone");
});

test("PiSession: failed model restoration is retried before the next turn, never silently kept", async () => {
  const { agent, session } = make();
  agent.failSetModel = (m) => m === A;
  assert.equal(await session.prompt("one", { model: "p/b", thinking: "low" }), "ran on b");
  assert.equal(agent.model, B);
  // Restoration still failing: the next turn fails instead of running on the override.
  await assert.rejects(session.prompt("two"), /setModel failed/);
  assert.deepEqual(agent.prompts, ["one"]);
  // Stop while the restoration retry is in flight: the turn must not start afterwards.
  agent.failSetModel = () => false;
  let release!: () => void;
  agent.gate = new Promise((r) => (release = r));
  const stopped = session.prompt("stopped");
  await new Promise((r) => setImmediate(r));
  await session.abort();
  agent.gate = undefined;
  release();
  assert.equal(await stopped, "");
  assert.equal(agent.model, A);
  assert.equal(agent.thinkingLevel, "high", "thinking restored with the model");
  assert.equal(await session.prompt("three"), "ran on a");
  assert.deepEqual(agent.prompts, ["one", "three"]);
});

test("PiSession: thinking clamped by a per-turn model is restored after the model", async () => {
  const { agent, session } = make();
  assert.equal(await session.prompt("x", { model: "p/b" }), "ran on b");
  assert.equal(agent.model, A);
  assert.equal(agent.thinkingLevel, "high");
  await session.prompt("y", { model: "p/b", thinking: "medium" });
  assert.equal(agent.thinkingLevel, "high");
});

test("PiSession: provider error stop surfaces as a failure", async () => {
  const { agent, session } = make();
  agent.prompt = async (text: string) => {
    agent.prompts.push(text);
    agent.messages.push({ role: "assistant", stopReason: "error", errorMessage: "429 upstream", content: [] });
  };
  await assert.rejects(session.prompt("x"), /429 upstream/);
});

test("tool details are lazy, bounded and do not invoke payload getters", () => {
  let inspected = false;
  const payload = { body: "x".repeat(1_000_000), get secret() { inspected = true; throw new Error("getter"); } };
  const event = toTurnEvent({type:"tool_execution_end",toolName:"bash",result:payload,isError:false} as any)!;
  assert.equal(inspected,false);
  if (event.type !== "tool") throw new Error("wrong event");
  assert.ok(event.detail!.length <= 2000);
  assert.equal(inspected,false);
});

test("toTurnEvent maps text deltas, tools and per-message usage", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = (e: unknown) => toTurnEvent(e as any);
  assert.deepEqual(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }), { type: "text", delta: "hi" });
  assert.equal(ev({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } }), undefined);
  assert.deepEqual(ev({ type: "tool_execution_end", toolName: "bash", isError: true }), { type: "tool", phase: "end", name: "bash", error: true });
  assert.deepEqual(
    ev({
      type: "message_end",
      message: { role: "assistant", provider: "p", model: "a", thinkingLevel: "low", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } },
    }),
    { type: "usage", model: "p/a", thinking: "low", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.5 },
  );
});
