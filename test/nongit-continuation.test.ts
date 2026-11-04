import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness.js';
import { accountRepetition, repetitions } from '../src/repetition-budget.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';

test('independently assessed analysis continues beyond 20 without Git, including durable restart', async () => {
  let turns = 0; let checks = 0;
  const runtime = new FakeRuntime(() => { turns++; return 'analysis checkpoint'; });
  const options = { runtime, now: () => 1000, completionCheck: async () => {
    checks++;
    return checks === 45 ? { state: 'completed' as const } : { state: 'continue' as const, next: 'Continue original analysis' };
  }};
  const home = await mkdtemp(path.join(os.tmpdir(), 'nongit-continuation-'));
  try {
    const file = path.join(home, 'sessions.json');
    const first = new Harness(options); first.addChannel(new MemoryChannel());
    // Serialize the test persistence adapter: background saveSoon callbacks may
    // overlap awaited writes. A paused turn alone is not a persistence barrier.
    let writes = Promise.resolve();
    first.onStateChange = () => {
      const snapshot = JSON.stringify(first.snapshotSessions());
      writes = writes.then(async () => {
        await writeFile(file + '.next', snapshot);
        await rename(file + '.next', file);
        if (checks === 25) first.paused = true;
      });
      return writes;
    };
    await first.accept(msg('Analyze original scope'));
    for (let i = 0; i < 1000 && !first.paused; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(first.paused, true);
    await writes;
    assert.equal(turns, 25); assert.equal(checks, 25);
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(snapshot[0].tasks[0].state, 'active');
    assert.equal(snapshot[0].tasks[0].repetition.repetitions, 0);
    const restored = new Harness(options); restored.addChannel(new MemoryChannel()); restored.onStateChange = async () => {};
    restored.restoreSessions(snapshot); await restored.tick(); await restored.drained();
    assert.equal(turns, 45); assert.equal(checks, 45);
    assert.equal(restored.snapshotSessions()[0]!.tasks![0]!.state, 'completed');
    assert.equal(repetitions(restored.snapshotSessions()[0]!.tasks![0]!), 1); // terminal turn, not a continue
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('identical successful validation receipts stay bounded despite changing model plans', async () => {
  let h: Harness; let turns = 0;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    runtime.sessions.get(key)!.options.at(-1)!.onEvent?.({ type: 'tool', phase: 'end', name: 'bash', callId: String(turns), detail: 'CI still running' });
    h.planContinuation(key, { state: 'continue', next: `poll again ${turns}` });
    return 'unchanged';
  });
  h = new Harness({ runtime, now: () => 1000, completionCheck: async () => ({ state: 'continue', next: 'Check same CI' }) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  await h.accept(msg('Validate CI within original scope')); await h.drained();
  assert.ok(turns <= 21); assert.equal(repetitions(h.snapshotSessions()[0]!.tasks![0]!), 20);
  await h.tick(); await h.drained(); assert.ok(turns <= 21);
});

for (const mode of ['fresh', 'error', 'missing'] as const) {
  test(`non-Git tool receipts: ${mode}`, async () => {
    let h: Harness; let turns = 0;
    const runtime = new FakeRuntime((_text, key) => {
      turns++;
      const onEvent = runtime.sessions.get(key)!.options.at(-1)!.onEvent!;
      onEvent({ type: 'tool', phase: 'start', name: 'read', callId: String(turns) });
      onEvent({ type: 'tool', phase: 'end', name: 'read', callId: String(turns),
        ...(mode === 'missing' ? {} : { detail: `observed document ${turns}` }), ...(mode === 'error' ? { error: true } : {}) });
      if (turns < 35) h.planContinuation(key, { state: 'continue', next: 'Validate original scope' });
      return 'checkpoint';
    });
    h = new Harness({ runtime, now: () => 1000,
      completionCheck: async () => turns < 35 ? { state: 'continue', next: 'Validate original scope', progress: { advanced: false } } : { state: 'completed' } });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    await h.accept(msg('Validate original scope')); await h.drained();
    assert.equal(turns, mode === 'fresh' ? 35 : 20);
    if (mode !== 'fresh') assert.equal(h.snapshotSessions()[0]!.tasks![0]!.state, 'blocked');
  });
}

test('normal independent continuation preserves prior stalls and total attempts', () => {
  const task = { depth: 0 };
  accountRepetition(task);
  accountRepetition(task, undefined, undefined, { normal: true });
  assert.equal(repetitions(task), 1);
  assert.equal((task as { repetition?: { attempts: number } }).repetition?.attempts, 2);
});

test('unfinished tools cannot qualify as normal analysis or a complete receipt', async () => {
  let h: Harness; let turns = 0;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    const onEvent = runtime.sessions.get(key)!.options.at(-1)!.onEvent!;
    onEvent({ type: 'tool', phase: 'start', name: 'read', callId: 'pending' });
    onEvent({ type: 'tool', phase: 'start', name: 'read', callId: 'finished' });
    onEvent({ type: 'tool', phase: 'end', name: 'read', callId: 'finished', detail: `fresh ${turns}` });
    h.planContinuation(key, { state: 'continue', next: 'Verify original scope' });
    return 'checkpoint';
  });
  h = new Harness({ runtime, now: () => 1000,
    completionCheck: async () => ({ state: 'continue', next: 'Verify original scope' }) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  await h.accept(msg('Verify original scope')); await h.drained();
  assert.equal(turns, 20); assert.equal(repetitions(h.snapshotSessions()[0]!.tasks![0]!), 20);
});

test('operator stop after turn 20 fences independent continuation', async () => {
  let turns = 0; let h: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => { turns++; return 'analysis'; }), now: () => 1000,
    completionCheck: async () => {
      if (turns === 24) await h.stopConversation('mem:room1');
      return { state: 'continue', next: 'Original scope only' };
    } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  await h.accept(msg('Analyze original scope')); await h.drained();
  assert.equal(turns, 24); assert.equal(h.snapshotSessions()[0]!.tasks![0]!.state, 'stopped');
  await h.tick(); await h.drained(); assert.equal(turns, 24);
});
