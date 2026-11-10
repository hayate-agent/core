import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommandContext, installCommands } from "../src/commands.js";
import { Harness } from "../src/harness.js";
import type { BenchmarkService } from "../src/benchmark/index.js";
import type { BenchmarkRunRecord } from "../src/benchmark/runner.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

function outcome(over: Partial<BenchmarkRunRecord["outcomes"][number]> = {}) {  return {
    caseId: "cache-reset", repeat: 1, taskId: "t1", requestId: "r1",
    pin: { model: "homelab/qwen3.8-27b-coder", thinking: "xhigh" }, status: "completed" as const,
    wallMs: 1500, workspace: "/tmp/w", attempts: [], fixed: [], tampered: [], extra: [], pinMatches: true, verified: true, ...over,
  };
}

const EPOCH = { revision: "abc123", version: "0.1.213", modelsFingerprint: "m1", settingsFingerprint: "s1" };

/** Command replies and proactive reports both travel through harness.deliver; look at everything said. */
function said(env: { ch: MemoryChannel; delivered: string[] }): string[] { return [...env.ch.texts(), ...env.delivered]; }

/** Deliveries land asynchronously after the command reply; poll instead of guessing tick counts. */
async function until(condition: () => boolean, what: string, limit = 500): Promise<void> {
  for (let waited = 0; waited < limit && !condition(); waited++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(condition(), `Erwartete Lieferung nicht erhalten: ${what}`);
}

function setup(options: { service?: Partial<BenchmarkService> | null; admins?: string[]; openAdmin?: boolean } = {}) {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60_000, busyMode: "queue", log: () => { } });
  harness.onStateChange = async () => { };
  const ch = new MemoryChannel();
  harness.addChannel(ch);
  const delivered: string[] = [];
  harness.deliver = async (_to, text) => { delivered.push(text); };
  const ctx: CommandContext = {
    harness, approvals: { mode: "off", tools: [] }, skills: () => [], reloadSkills: async () => { },
    personality: { get current() { return undefined; }, available: async () => [], set: async () => { } },
    admins: options.admins ?? ["operator"], agent: "agent", restart: async () => { }, openAdmin: options.openAdmin,
    ...(options.service === null ? {} : { benchmark: options.service as BenchmarkService }),
  };
  installCommands(ctx);
  const send = async (text: string) => { await harness.submit(msg(text, "operator")); await harness.drained(); };
  return { ch, ctx, delivered, send, harness };
}

function fakeService(over: Partial<BenchmarkService> = {}): Partial<BenchmarkService> {
  return {
    suites: async () => ["levels", "review-quality"],
    status: () => ({
      enabled: true, runsDir: "/home/node/.vanillacore-harness/benchmark/runs", suitesDir: "/home/node/.vanillacore-harness/benchmark/suites",
      config: { enabled: true, capacity: 1, repeats: 3, caseTimeoutMs: 900_000 }, running: null,
    }),
    run: async (_name, _parent, onProgress) => {
      onProgress?.(outcome());
      onProgress?.(outcome({ repeat: 2, verified: false, status: "timeout", tampered: ["test.js"] }));
      return { id: "levels-1", suite: "levels", fingerprint: "fp", epoch: EPOCH, startedAt: 1, finishedAt: 2, outcomes: [outcome(), outcome({ repeat: 2, verified: false, status: "timeout", tampered: ["test.js"] })] };
    },
    report: async (suite?: string) => `Bericht${suite ? ` für ${suite}` : ""}`,
    latest: async () => [],
    load: async () => { throw new Error("nicht Teil dieses Tests"); },
    save: async () => "/tmp/suite.yaml",
    ...over,
  } as Partial<BenchmarkService>;
}

test("the benchmark command is admin-only and says so when the subsystem is absent", async () => {
  const guest = setup({ service: fakeService(), admins: [], openAdmin: false });
  await guest.send("/benchmark list");
  assert.match(said(guest).at(-1)!, /admin only/);

  const bare = setup({ service: null });
  await bare.send("/benchmark list");
  assert.match(said(bare).at(-1)!, /nicht verfügbar/);
});

test("/benchmark lists suites and shows the effective configuration", async () => {
  const env = setup({ service: fakeService() });
  await env.send("/benchmark");
  const reply = said(env).at(-1)!;
  assert.match(reply, /Benchmark aktiv · capacity 1 · repeats 3 · Fall-Budget 15 min/);
  assert.match(reply, /Bekannte Suites: levels, review-quality/);
  assert.match(reply, /Start: \/benchmark <suite>/);
  await env.send("/benchmark status");
  const statusReply = said(env).filter(text => /capacity 1/.test(text)).at(-1)!;
  assert.match(statusReply, /capacity 1/);
  assert.doesNotMatch(statusReply, /Bekannte Suites/);
});

test("report goes to the service and junk arguments get usage instead of a run", async () => {
  const env = setup({ service: fakeService() });
  await env.send("/benchmark report review-quality");
  assert.ok(said(env).includes("Bericht für review-quality"));
  await env.send("/benchmark ../../etc");
  assert.match(said(env).at(-1)!, /usage: \/benchmark/);
});

test("a disabled subsystem refuses to start a run", async () => {
  const env = setup({ service: fakeService({ status: () => ({ ...fakeService().status!(), enabled: false }) }) });
  await env.send("/benchmark levels");
  assert.match(said(env).at(-1)!, /deaktiviert/);
  assert.deepEqual(env.delivered.filter(text => text.startsWith("Benchmark cache-reset#") || /###/.test(text)), [], "nothing was queued and no report delivered");
});

test("a started run answers immediately and reports progress while the workers run", async () => {
  const env = setup({ service: fakeService() });
  await env.send("/benchmark levels");
  assert.match(said(env).at(-1)!, /Benchmark "levels" gestartet/);
  assert.match(said(env).at(-1)!, /während die lokalen Worker laufen/);
  await until(() => env.delivered.some(text => /### levels — levels-1/.test(text)), "Abschlusstabellen-Bericht");
  const progress = env.delivered.filter(text => text.startsWith("Benchmark cache-reset#"));
  assert.equal(progress.length, 2, "one progress line per outcome");
  assert.match(progress[0]!, /cache-reset#1 \[xhigh\] completed · 0 Attempt\(s\) · nichts gefixt · verifiziert/);
  assert.match(progress[1]!, /manipuliert: test\.js · NICHT verifiziert/);
  assert.match(env.delivered.find(text => /### levels/.test(text))!, /Nicht verifiziert:/);
});

test("a failing run is reported instead of dying silently", async () => {
  const env = setup({ service: fakeService({ run: async () => { throw Error("Pinned worker thinking level unsupported: xhigh"); } }) });
  await env.send("/benchmark levels");
  await until(() => env.delivered.some(text => /fehlgeschlagen/.test(text)), "Fehlerbericht");
  assert.match(env.delivered.find(text => /fehlgeschlagen/.test(text))!, /Pinned worker thinking level unsupported/);
});
