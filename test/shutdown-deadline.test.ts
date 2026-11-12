import { test } from "node:test";
import assert from "node:assert/strict";
import { ShutdownDeadline } from "../src/shutdown-deadline.js";
import { Harness } from "../src/harness.js";
import { installCommands, type CommandContext } from "../src/commands.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

test("all shutdown phases share one absolute deadline, never a fresh allowance per owner", async () => {
  let clock = 10_000, expired = 0;
  const deadline = new ShutdownDeadline(60_000, () => expired++, () => clock);
  try {
    assert.equal(deadline.remaining(), 60_000);
    clock += 54_000; assert.equal(deadline.remaining(), 6000); assert.equal(deadline.remaining(5000), 1000);
    clock += 7000; assert.equal(deadline.remaining(), 0);
    assert.equal(await deadline.wait(new Promise<number>(() => {}), 3000, () => 42), 42);
    assert.equal(expired, 0);
  } finally { deadline.close(); }
});

test("hung callback cannot hold the process-owner deadline indefinitely", async () => {
  let expired = false;
  const deadline = new ShutdownDeadline(30, () => { expired = true; });
  try {
    assert.equal(await deadline.wait(new Promise<boolean>(() => {}), 10, () => false), false);
    for (let n = 0; !expired && n < 100; n++) await delay(5);
    assert.equal(expired, true);
  } finally { deadline.close(); }
});

test("completed phases cancel their timer and rejected persistence stays visible", async () => {
  let expired = false;
  const deadline = new ShutdownDeadline(30, () => { expired = true; });
  assert.equal(await deadline.wait(Promise.resolve("saved"), 100, () => "fallback"), "saved");
  await assert.rejects(deadline.wait(Promise.reject(Error("disk unavailable")), 100, () => "fallback"), /disk unavailable/);
  deadline.close(); await delay(40); assert.equal(expired, false);
});

test("restart command reaches its host immediately during active work; fences new ingress and retains interrupted input", async () => {
  const runtime = new FakeRuntime(); const channel = new MemoryChannel();
  const harness = new Harness({ runtime, tickMs: 60_000 }); harness.addChannel(channel);
  let release!: () => void;
  const open = runtime.open.bind(runtime);
  runtime.open = async (...args) => { const session = await open(...args); release = runtime.sessions.get(args[0])!.hold(); return session; };
  harness.onStateChange = async () => {};
  let restart = false; let stopping: Promise<ReturnType<Harness["pendingInputs"]>> | undefined;
  const context = { harness, admins: ["operator"], approvers: [], skills: () => [], pluginCommands: new Map(),
    agent: "agent", restart: async () => { restart = true; stopping = harness.stop(0, 50); } } as unknown as CommandContext;
  installCommands(context);
  try {
    const input = { ...msg("Retain my authorized original", "operator"), id: "original" };
    await harness.accept(input);
    for (let n = 0; !release && n < 100; n++) await delay(2);
    assert.ok(release);
    await harness.accept({ ...msg("/restart", "operator"), id: "restart-command" });
    assert.equal(restart, true); assert.equal(harness.stopping, true);
    await assert.rejects(harness.accept({ ...msg("new work", "operator"), id: "too-late" }), /shutting down/);
    const retained = await stopping!;
    assert.ok(retained.some(item => item.id === "original"));
    assert.ok(!retained.some(item => item.id === "too-late"));
  } finally { release?.(); await harness.stop(0, 50); }
});
