import assert from 'node:assert/strict';
import test from 'node:test';
import { Harness } from '../src/harness.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';
import { assessCompletion } from './completion-default.js';
import { accountRepetition, repetitions } from '../src/repetition-budget.js';

test('milestone replay after restore, malformed assessment and full history fail closed', () => {
  const task = { depth: 0 };
  accountRepetition(task, undefined, undefined, { advanced: true, fingerprint: 'verified requirement' });
  const restored = JSON.parse(JSON.stringify(task));
  accountRepetition(restored, undefined, undefined, { advanced: true, fingerprint: 'verified requirement' });
  assert.equal(repetitions(restored), 1);
  accountRepetition(restored, undefined, undefined, { advanced: true, fingerprint: '\\ninvalid' });
  assert.equal(repetitions(restored), 2);
  restored.repetition.evidence = Array.from({ length: 256 }, (_, i) => `seen-${i}`);
  accountRepetition(restored, undefined, undefined, { advanced: true, fingerprint: 'fresh' });
  assert.equal(repetitions(restored), 3); assert.equal(restored.repetition.evidence.length, 256);
});

for (const progress of [null, { advanced: 'yes', fingerprint: 'milestone' }, { advanced: true, fingerprint: '\\ninvalid' }])
test(`invalid progress is omitted without expanding authority: ${JSON.stringify(progress)}`, async () => {
  const plan = await assessCompletion({ review: async () => JSON.stringify({ state: 'continue', next: 'verify', progress }) },
    { source: 'channel', sessionKey: 'chat', text: 'verify' }, 'result', { task: 'verify' }, new AbortController().signal);
  assert.deepEqual(plan, { state: 'continue', next: 'verify' });
});

test('working-model progress field cannot grant credit without independent assessment', async () => {
  let turns = 0;
  const runtime = new FakeRuntime((_text, key) => {
    turns++; h.planContinuation(key, { state: 'continue', next: 'retry', progress: { advanced: true, fingerprint: `fake-${turns}` } });
    return `Progress claim ${turns}`;
  });
  const h = new Harness({ runtime, tickMs: 60000 }); h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg('Verify approved scope')); await h.drained();
    assert.equal(turns, 1, 'model progress cannot grant admission');
    assert.equal(h.state('mem:room1').task?.state, 'active', 'missing assessor is technical unresolved, not semantic blocked');
    assert.equal(h.state('mem:room1').task?.explicitBlocked, false);
    assert.equal(h.state('mem:room1').task?.recoveryRetry?.diagnostic, 'unavailable');
    assert.equal(h.state('mem:room1').task?.recoveryAdmission, undefined);
    assert.equal(h.pendingInputs().length, 0);
  }
  finally { await h.stop(0); }
});

for (const kind of ['checks', 'analysis'] as const) test(`productive ${kind} with an unchanged Git tree exceeds the retry allowance`, async () => {
  let turns = 0;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    if (kind === 'checks') runtime.sessions.get(key)!.options.at(-1)!.onEvent?.({
      type: 'tool', phase: 'end', name: 'bash', detail: `Verified distinct regression ${turns}: PASS`,
    });
    h.planContinuation(key, { state: 'completed' });
    return `Analysis result ${turns}: independently verified remaining requirement`;
  });
  const h = new Harness({ runtime, tickMs: 60000, progressEvidence: async () => 'unchanged-tree',
    completionCheck: (input, reply, signal) => assessCompletion({ review: async prompt => {
      if (kind === 'checks') assert.match(prompt, new RegExp(`Verified distinct regression ${turns}: PASS`));
      return JSON.stringify({ state: turns < 35 ? 'continue' : 'completed',
        next: 'Verify the next authorized requirement', progress: { fingerprint: `requirement-${turns}`, advanced: true } });
    } }, input, reply, { task: input.completionAnchor!.task }, signal) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg('Analyze and verify all approved requirements')); await h.drained();
    assert.equal(turns, 35);
    assert.equal(h.snapshotSessions()[0].task?.state, 'completed');
    assert.equal(h.snapshotSessions()[0].task?.repetition?.repetitions, 0);
  } finally { await h.stop(0); }
});

test('repeated checker-approved fingerprint is still bounded despite changing prose', async () => {
  let turns = 0;
  const runtime = new FakeRuntime((_text, key) => {
    turns++; h.planContinuation(key, { state: 'completed' }); return `Different wording ${turns}`;
  });
  const h = new Harness({ runtime, tickMs: 60000, progressEvidence: async () => 'unchanged-tree',
    completionCheck: async () => ({ state: 'continue', next: `Try again ${turns}`,
      progress: { fingerprint: 'same-unresolved-requirement', advanced: true } }) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg('Complete the approved requirement')); await h.drained();
    assert.equal(turns, 21); assert.equal(h.snapshotSessions()[0].task?.state, 'blocked');
    await h.tick(); await h.drained(); assert.equal(turns, 21);
  } finally { await h.stop(0); }
});
