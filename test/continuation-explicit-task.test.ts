import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Harness, type DurableTask } from '../src/harness.js';
import { PluginHost } from '../src/plugins.js';
import { continuationPlugin } from '../src/builtin-plugins/continuation-plugin.js';
import { FakeRuntime, MemoryChannel, ROOM } from './fakes.js';

const key = 'mem:room1';
const fleet = (): DurableTask => ({ id: 'fleet', original: 'Verify authorized fleet deployment; no other agents',
  anchor: { id: 'fleet-anchor', task: 'Verify authorized fleet deployment; no other agents', receivedAt: 1 },
  state: 'active', depth: 3, expiresAt: 800000 });
const clone = <T>(v: T): T => structuredClone(v);

test('registered new adapter fails closed on actual old Core method; default remains compatible', async () => {
  // Verbatim old Core method, not a stub or a moving HEAD baseline.
  // Core 5660b6fed7ca6e77e7fe06c6cbc0dbbb0bfb4c8a, src/harness.ts
  // blob d19be9801e0ca1dcbe309625c91d95023681bd5d; no trailing newline added.
  // This channel-turn fixture exercises the old checkpoint path without host-only helpers.
  const method = readFileSync(new URL('./fixtures/plan-continuation-core-5660b6f.txt', import.meta.url), 'utf8');
  const oldPlan = new Function(`${stripTypeScriptTypes(`function ${method.trim()}`)}; return planContinuation;`)();
  const input = { id: 'fleet', source: 'channel', continuation: { state: 'blocked', next: 'Preserve checkpoint' } };
  const oldCore = { sessions: new Map([[key, { current: input, prompting: true }]]), planContinuation: oldPlan };
  const host = new PluginHost();
  await host.load([], { home: '/tmp', cwd: '/tmp', agent: 'fixture' }, [], [], [continuationPlugin(oldCore as unknown as Harness)]);
  try {
    const tool = host.tools.get('plugin_task_continuation')!;
    const before = clone(input);
    // No Harness-caught runtime assertions: rejection and exact checkpoint equality are test outcomes.
    await assert.rejects(tool.execute({ taskId: 'readonly-own-ID', state: 'completed' }, { sessionKey: key }), /Explicit taskId continuation requires Core support/);
    assert.deepEqual(input, before);
    await tool.execute({ state: 'completed' }, { sessionKey: key });
    assert.deepEqual(input.continuation, { state: 'completed' });
  } finally { await host.stop(); }
});

test('registered tool: explicit fleet wait, own-ID question completion, reload, exactly one original-scope turn', async () => {
  let now = 1000;
  const host = new PluginHost();
  let h: Harness;
  let calls = 0;
  const runtime = new FakeRuntime((async () => {
    const tool = host.tools.get('plugin_task_continuation')!;
    assert.ok(tool.parameters.properties!.taskId);
    if (++calls === 1) {
      assert.equal(h.continuationTasks(key).currentTaskId, 'retry-question');
      assert.ok(h.continuationTasks(key).eligible.some(t => t.id === 'fleet'));
      await tool.execute({ taskId: 'fleet', state: 'waiting', next: 'Inspect existing fleet rollout read-only',
        wait: { reason: 'rollout pending', retryAfterMs: 60000, deadline: 700000 } }, { sessionKey: key } as never);
      // Selection is a checkpoint, not replacement of current-turn authority.
      assert.equal(h.continuationTasks(key).currentTaskId, 'retry-question');
    } else {
      await tool.execute({ taskId: 'readonly-question', state: 'completed' }, { sessionKey: key } as never);
    }
    return 'Read-only result';
  }) as unknown as (text: string) => string);
  const assessed: Array<{ id?: string; original?: string }> = [];
  h = new Harness({ runtime, now: () => now, tickMs: 60000,
    completionCheck: async input => { assessed.push({ id: input.taskId, original: input.completionAnchor?.task }); return input.taskId === 'readonly-question' ? { state: 'completed' } : undefined; } });
  h.restoreSessions([{ key, tasks: [fleet()] }]);
  let saved: ReturnType<Harness['snapshotSessions']> = [];
  h.onStateChange = async () => { saved = clone(h.snapshotSessions()); };
  h.addChannel(new MemoryChannel());
  await host.load([], { home: '/tmp', cwd: '/tmp', agent: 'fixture' }, [], [], [continuationPlugin(h)]);
  let snapshot: typeof saved;
  try {
    await h.start();
    await h.accept({ id: 'retry-question', sessionKey: key, source: 'channel', text: 'Register fleet verification wait', replyTo: ROOM });
    await h.drained();
    const waiting = h.snapshotSessions()[0].tasks!.find(t => t.id === 'fleet')!;
    assert.equal(waiting.state, 'waiting'); assert.equal(waiting.wait?.nextAt, 61000);
    assert.equal(waiting.depth, 3); assert.equal(waiting.expiresAt, 800000);
    assert.deepEqual(assessed[0], { id: 'fleet', original: fleet().original });
    await h.accept({ id: 'readonly-question', sessionKey: key, source: 'channel', text: 'Only answer this read-only question', replyTo: ROOM });
    await h.drained();
    snapshot = clone(saved);
    assert.deepEqual(snapshot[0].tasks!.find(t => t.id === 'fleet'), waiting);
    assert.equal(snapshot[0].tasks!.find(t => t.id === 'readonly-question')!.state, 'completed');
    assert.equal(snapshot[0].tasks!.find(t => t.id === 'retry-question')!.state, 'active');
  } finally { await h.stop(0); await host.stop(); }
  let turns = 0;
  let restarted: Harness;
  const followRuntime = new FakeRuntime(() => {
    turns++;
    assert.equal(restarted.continuationTasks(key).currentTaskId, 'fleet');
    restarted.planContinuation(key, { taskId: 'fleet', state: 'completed' });
    return 'Fleet verification complete';
  });
  restarted = new Harness({ runtime: followRuntime, now: () => now, tickMs: 60000,
    // This fixture's separate registration question is answered, not fleet work.
    completionCheck: async input => input.taskId === 'retry-question' ? { state: 'completed' } : undefined });
  restarted.restoreSessions(snapshot!);
  let persisted = false;
  restarted.onStateChange = async () => { persisted = true; };
  restarted.addChannel(new MemoryChannel());
  try {
    await restarted.start(); now = 61000;
    await restarted.tick(); await restarted.drained();
    assert.equal(persisted, true); assert.equal(turns, 1);
    assert.ok(followRuntime.sessions.get(key)!.prompts[0].includes(fleet().original));
    await restarted.tick(); await restarted.drained(); assert.equal(turns, 1);
  } finally { await restarted.stop(0); }
});

test('unknown, foreign, expired, stopped, completed, unanchored targets fail closed without changing current task', async () => {
  for (const invalid of ['unknown', 'foreign', 'expired', 'stopped', 'completed', 'unanchored', 'deadline'] as const) {
    const target = fleet();
    if (invalid === 'expired') target.expiresAt = 999;
    if (invalid === 'stopped' || invalid === 'completed') target.state = invalid;
    if (invalid === 'unanchored') target.anchor = undefined;
    if (invalid === 'deadline') { target.state = 'waiting'; target.wait = { reason: 'old', nextAt: 500, deadline: 999 }; }
    let h: Harness;
    let verified = 0;
    const runtime = new FakeRuntime(() => {
      const before = clone(h.snapshotSessions());
      assert.throws(() => h.planContinuation(key, { taskId: invalid === 'unknown' ? 'missing' : 'fleet', state: 'completed' }), /eligible/);
      assert.deepEqual(h.snapshotSessions(), before);
      verified++;
      h.planContinuation(key, { state: 'completed' });
      return 'Own question complete';
    });
    h = new Harness({ runtime, now: () => 1000 });
    h.restoreSessions([{ key: invalid === 'foreign' ? 'mem:foreign' : key, tasks: invalid === 'unknown' ? [] : [target] }]);
    h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
    try { await h.start(); await h.accept({ id: 'own', source: 'channel', sessionKey: key, text: 'Read-only', replyTo: ROOM }); await h.drained(); assert.equal(verified, 1, invalid); }
    finally { await h.stop(0); }
  }
});
