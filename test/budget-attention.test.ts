import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness } from '../src/harness.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionStore } from '../src/execution.js';
import { guardResultOrchestration } from '../src/result-orchestration.js';

const key = 'mem:room1';
function fixture() {
  const runtime = new FakeRuntime();
  let now = 61000;
  const h = new Harness({ runtime, now: () => now });
  const channel = new MemoryChannel(); h.addChannel(channel);
  h.onStateChange = async () => {};
  h.restoreSessions([{ key, replyTo: { channel: 'mem', target: 'room1' }, task: {
    id: 'old', original: 'Finish authorized work', state: 'waiting', depth: 19,
    next: 'Read dependency result, do not replay effects',
    wait: { reason: 'pending dependency', nextAt: now, deadline: 1000000 },
  } }]);
  return { h, channel, runtime, time: (n: number) => { now = n; } };
}

test('pending wait -> shell status charge -> exhaustion -> blocked next and durable once-only attention -> restart', async () => {
  const f = fixture();
  const open = f.runtime.open.bind(f.runtime);
  let checks = 0;
  f.runtime.open = async (...args) => {
    const s = await open(...args);
    s.prompt = async () => {
      checks++;
      if (checks === 1) {
        // Shell reads are intentionally not classified as safe status tools.
        await f.h.guardWaitTool(key, 'bash', { command: 'read status' });
        f.h.planContinuation(key, { state: 'waiting', next: 'Inspect existing dependency',
          wait: { reason: 'pending dependency', retryAfterMs: 60000, deadline: 1000000 } });
      } else {
        await assert.rejects(f.h.guardWaitTool(key, 'bash', {}), /budget exhausted/);
        await assert.rejects(f.h.guardWaitTool(key, 'bash', {}), /budget exhausted/);
        await f.h.guardWaitTool(key, 'plugin_dispatch', { action: 'status' });
        f.h.planContinuation(key, { state: 'blocked', next: 'Dependency complete; further integration needs operator mandate' });
      }
      return 'NO_REPLY';
    };
    return s;
  };
  await f.h.tick(); await f.h.drained();
  assert.equal(f.h.state(key).task!.depth, 20);
  f.time(121000); await f.h.tick(); await f.h.drained();
  const task = f.h.snapshotSessions()[0].task!;
  assert.equal(task.state, 'blocked');
  assert.equal(task.termination, 'productive_budget_exhausted');
  assert.match(task.next!, /Dependency complete/);
  assert.equal(f.channel.sent.length, 1);
  assert.match(f.channel.sent[0].text, /Aktionsbudget erschöpft/);
  const sessions = JSON.parse(JSON.stringify(f.h.snapshotSessions()));
  await f.h.stop(0);
  const r = new FakeRuntime(); const h = new Harness({ runtime: r, now: () => 181000 });
  const ch = new MemoryChannel(); h.addChannel(ch); h.onStateChange = async () => {};
  h.restoreSessions(sessions);
  try {
    await h.recoverTasks(); await h.tick(); await h.drained();
    assert.equal(r.sessions.size, 0, 'blocked work must not be nudged/replayed');
    assert.equal(ch.sent.length, 0, 'persisted notice marker deduplicates restart');
    const oldDepth = h.state(key).task!.depth;
    await h.submit(msg('New explicit repair mandate')); await h.drained();
    assert.equal(h.state(key).task!.depth, 0);
    assert.equal(h.state(key).tasks!.find(t => t.id === 'old')!.depth, oldDepth);
  } finally { await h.stop(0); }
});

for (const revoke of ['stopped', 'expired'] as const) test(`no attention or work after ${revoke}`, async () => {
  const f = fixture(); const task = f.h.state(key).task!;
  task.depth = 20;
  if (revoke === 'stopped') task.state = 'stopped';
  else task.expiresAt = 1;
  try {
    await f.h.tick(); await f.h.drained();
    assert.equal(f.channel.sent.length, 0);
    assert.equal(f.runtime.sessions.size, 0);
  } finally { await f.h.stop(0); }
});


test('later completed dependency is consumed once at exhausted depth without work replay', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'budget-result-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, 'ledger.json')); await store.load();
  const runtime = new FakeRuntime(); const channel = new MemoryChannel();
  const h = new Harness({ runtime, executionStore: store, now: () => 61000, hostEventAllowed: () => true });
  h.addChannel(channel); h.onStateChange = async () => {};
  h.restoreSessions([{ key, replyTo: { channel: 'mem', target: 'room1' }, task: {
    id: 'parent', original: 'Complete approved tests only', state: 'blocked', depth: 20,
    next: 'Consume existing review result', expiresAt: 1000000,
  } }]);
  const child = await store.submit(key, 'review', 'Review existing candidate', 'direct', 1,
    { taskId: 'parent', original: 'Complete approved tests only', depth: 19 });
  const claim = await store.claim(child.id);
  await store.complete(child.id, claim.token!, 'Review complete; further integration pending');
  let consumed = 0;
  const open = runtime.open.bind(runtime);
  runtime.open = async (...args) => {
    const s = await open(...args);
    s.prompt = async () => {
      consumed++;
      guardResultOrchestration(h, key, 'plugin_dispatch', { action: 'status' });
      assert.throws(() => guardResultOrchestration(h, key, 'plugin_dispatch', { action: 'submit' }), /budget exhausted/);
      h.planContinuation(key, { state: 'blocked', next: 'Review consumed; operator mandate needed for integration' });
      return 'Review result received; no effects replayed.';
    };
    return s;
  };
  try {
    const event = { id: 'result:review', sessionKey: key, source: 'host' as const,
      hostEvent: { executionId: child.id }, text: 'Review completed' };
    await h.accept(event); await h.drained();
    await h.accept(event); await h.drained();
    await h.tick(); await h.drained();
    assert.equal(consumed, 1);
    assert.equal(store.list(key).length, 1);
    assert.equal(h.state(key).task!.depth, 20);
    assert.equal(channel.sent.filter(s => s.text.includes('Aktionsbudget erschöpft')).length, 1);
  } finally { await h.stop(0); }
});


test('legacy blocked checkpoint persists attention before delivery and retries storage without model work', async () => {
  const f = fixture(); const task = f.h.state(key).task!;
  task.state = 'blocked'; task.depth = 20;
  let offline = true;
  f.h.onStateChange = async () => { if (offline) throw Error('disk offline'); };
  try {
    await f.h.tick(); await new Promise(r => setTimeout(r, 10));
    assert.equal(f.channel.sent.length, 0);
    assert.equal(f.h.outboxEntries().length, 1);
    assert.ok(task.budgetAttentionId);
    offline = false;
    await f.h.tick(); await f.h.drained();
    await f.h.tick(); await f.h.drained();
    assert.equal(f.channel.sent.length, 1);
    assert.equal(f.runtime.sessions.size, 0);
  } finally { await f.h.stop(0); }
});
