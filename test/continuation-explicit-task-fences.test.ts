import { confirmNonproductive } from "./fakes.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness, type DurableTask } from '../src/harness.js';
import { FakeRuntime, MemoryChannel, ROOM } from './fakes.js';
const key = 'mem:room1';
const task = (): DurableTask => ({ id: 'fleet', original: 'Only verify existing rollout',
  anchor: { id: 'anchor', task: 'Only verify existing rollout', receivedAt: 1 }, state: 'waiting',
  next: 'Inspect existing rollout', depth: 4, expiresAt: 900000,
  wait: { reason: 'pending', nextAt: 61000, deadline: 800000 } });

test('explicit continue is saved before effect; failed save holds it and retry executes exactly once with original anchor', async () => {
  let h: Harness, prompts = 0, fail = false, savedAdmission = false;
  const runtime = new FakeRuntime(() => {
    if (++prompts === 1) {
      h.planContinuation(key, { taskId: 'fleet', state: 'continue', next: 'Read rollout result' });
      fail = true;
    } else {
      assert.equal(savedAdmission, true);
      assert.equal(h.continuationTasks(key).currentTaskId, 'fleet');
      h.planContinuation(key, { taskId: 'fleet', state: 'completed' });
    }
    return 'Verified result';
  });
  h = new Harness({ runtime, now: () => 1000, tickMs: 60000, completionCheck: async () => prompts === 1 ? { state: "continue", next: "Read rollout result" } : { state: "completed" } });
  h.restoreSessions([{ key, tasks: [task()] }]); h.addChannel(new MemoryChannel());
  h.onStateChange = async () => {
    if (fail) throw Error('disk unavailable');
    if (h.pendingInputs().some(i => i.taskId === 'fleet')) savedAdmission = true;
  };
  try {
    await h.start(); await h.accept({ id: 'question', sessionKey: key, source: 'channel', text: 'Schedule original task', replyTo: ROOM });
    for (let i = 0; i < 100 && !h.pendingInputs().some(input => input.taskId === 'fleet'); i++)
      await new Promise(resolve => setImmediate(resolve));
    assert.equal(prompts, 1);
    assert.equal(h.pendingInputs().filter(i => i.taskId === 'fleet').length, 1);
    fail = false; await h.tick(); await h.drained(); assert.equal(prompts, 2);
    assert.ok(runtime.sessions.get(key)!.options[1].instructions!.includes('Only verify existing rollout'));
    await h.tick(); await h.drained(); assert.equal(prompts, 2);
  } finally { fail = false; await h.stop(0); }
});

test('a later default checkpoint still completes current question, not previously selected fleet', async () => {
  let h: Harness;
  const runtime = new FakeRuntime(() => {
    h.planContinuation(key, { taskId: 'fleet', state: 'continue', next: 'Read rollout result' });
    h.planContinuation(key, { state: 'completed' });
    return 'Only the question is complete';
  });
  h = new Harness({ completionCheck: confirmNonproductive, runtime, now: () => 1000 }); h.restoreSessions([{ key, tasks: [task()] }]);
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
  try {
    await h.start(); await h.accept({ id: 'question', sessionKey: key, source: 'channel', text: 'Read-only', replyTo: ROOM }); await h.drained();
    assert.deepEqual(h.snapshotSessions()[0].tasks!.find(t => t.id === 'fleet'), task());
    assert.equal(h.snapshotSessions()[0].tasks!.find(t => t.id === 'question')!.state, 'completed');
  } finally { await h.stop(0); }
});

test('cancel or expiry while assessor runs cannot apply the targeted checkpoint', async () => {
  for (const revoke of ['cancel', 'expiry'] as const) {
    let now = 1000, release!: () => void, entered!: () => void, h: Harness;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const runtime = new FakeRuntime(() => {
      h.planContinuation(key, { taskId: 'fleet', state: 'completed' }); return 'Narrow claim';
    });
    h = new Harness({ runtime, now: () => now, completionCheck: async () => {
      entered(); await gate; return { state: 'completed' };
    } });
    h.restoreSessions([{ key, tasks: [task()] }]); h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
    try {
      await h.start(); const accepted = h.accept({ id: 'question', sessionKey: key, source: 'channel', text: 'Read-only', replyTo: ROOM });
      await started;
      if (revoke === 'cancel') await h.stopConversation(key); else now = 900001;
      release(); await accepted; await h.drained();
      const fleet = h.snapshotSessions()[0].tasks!.find(t => t.id === 'fleet')!;
      assert.notEqual(fleet.state, 'completed'); assert.equal(h.pendingInputs().length, 0);
    } finally { release(); await h.stop(0); }
  }
});
