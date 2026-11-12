import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';

const key = 'mem:room1';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
for (const mode of ['queued-before', 'queued-during', 'no-verdict', 'inconclusive'] as const) {
  for (const restart of [false, true]) test(`unresolved supervisor remains scheduled: ${mode}, restart=${restart}`, async () => {
    let now = 1000, originalTurns = 0, effects = 0, recoveryChecks = 0;
    let h: Harness;
    const check: NonNullable<ConstructorParameters<typeof Harness>[0]['completionCheck']> = async (input, _reply, _signal, diagnostic) => {
      if (effects) return { state: 'completed' };
      if (input.source === 'heartbeat') {
        recoveryChecks++;
        assert.match(input.completionAnchor!.task, /Implement ORIGINAL/);
        return { state: 'continue', next: 'Reconcile prior receipts and run missing acceptance test' };
      }
      if (input.text === 'Clarification: retain merge permission' || effects) return { state: 'completed' };
      if (mode === 'queued-during') {
        await h.submit(msg('Clarification: retain merge permission'));
        return { state: 'continue', next: 'STALE admission must not run' };
      }
      if (mode === 'inconclusive') diagnostic?.('inconclusive');
      return undefined;
    };
    const make = (runtime: FakeRuntime) => {
      const instance = new Harness({ runtime, now: () => now, tickMs: 600000, busyMode: 'queue', completionCheck: check });
      instance.addChannel(new MemoryChannel()); instance.onStateChange = async () => {};
      return instance;
    };
    const runtime = new FakeRuntime(async text => {
      if (text === 'Implement ORIGINAL and test') {
        originalTurns++;
        h.planContinuation(key, { state: 'continue', next: 'Untrusted proposal retained for reassessment' });
        if (mode === 'queued-before') await h.submit(msg('Clarification: retain merge permission'));
        return 'Existing implementation receipt; acceptance test remains';
      }
      if (text === 'Clarification: retain merge permission') return 'Clarification acknowledged';
      effects++;
      assert.doesNotMatch(text, /STALE admission/);
      return 'Acceptance verified';
    });
    h = make(runtime);
    try {
      await h.submit(msg('Implement ORIGINAL and test')); await h.drained();
      const task = h.snapshotSessions()[0].tasks!.find(t => t.original === 'Implement ORIGINAL and test')!;
      assert.equal(task.state, 'active');
      assert.equal(task.explicitBlocked, false);
      assert.equal(task.supervisorDecision?.verdict, 'unresolved');
      if (mode.startsWith('queued')) assert.equal(task.supervisorDecision?.deferred, 'queued-input');
      assert.equal(task.recoveryAdmission, undefined);
      assert.ok(task.recoveryRetry, 'a non-decision must have a durable retry owner');
      assert.equal(effects, 0);
      const due = task.recoveryRetry.nextAt;
      if (restart) {
        const saved = copy(h.snapshotSessions()); await h.stop(0);
        h = make(new FakeRuntime(() => { effects++; return 'Acceptance verified'; })); h.restoreSessions(saved);
      }
      now = due - 1; await h.tick(); assert.equal(recoveryChecks, 0);
      now = due; await h.tick(); h.releaseRestored(); await h.drained();
      assert.equal(recoveryChecks, 1); assert.equal(effects, 1); assert.equal(originalTurns, 1);
    } finally { await h.stop(0); }
  });
}

test('fresh semantic denial supersedes a migrated non-decision and is not automatically retried', async () => {
  let checks = 0, now = 1000;
  const h = new Harness({ runtime: new FakeRuntime(() => { assert.fail('no work on semantic denial'); }), now: () => now, tickMs: 600000,
    completionCheck: async () => { checks++; return { state: 'blocked' }; } });
  h.onStateChange = async () => {};
  h.restoreSessions([{ key, tasks: [{ id: 'p', original: 'Implement ORIGINAL', state: 'blocked', depth: 0,
    recoveryEnrollment: 'current', explicitBlocked: true, next: 'Retained proposal', supervisorDecision: { proposal: 'continue', verdict: 'unresolved' } }] }]);
  try {
    await h.recoverTasks();
    assert.equal(checks, 0);
    now += 60001;
    await h.recoverTasks(); await h.recoverTasks(); await h.tick();
    assert.equal(checks, 1);
    assert.equal(h.state(key).tasks![0].supervisorDecision?.verdict, 'blocked');
    assert.equal(h.state(key).tasks![0].state, 'blocked');
    assert.equal(h.pendingInputs().length, 0);
  } finally { await h.stop(0); }
});

for (const gate of ['none', 'semantic-blocked', 'stopped', 'expired', 'held-legacy'] as const) {
  test(`recover saved false block without overriding real gate: ${gate}`, async () => {
    let checks = 0, effects = 0, now = 1000;
    const h = new Harness({ runtime: new FakeRuntime(() => { effects++; return 'done'; }), now: () => now, tickMs: 600000,
      completionCheck: async () => { if (effects) return { state: 'completed' }; checks++; return { state: 'continue', next: 'Reconcile receipt before remaining work' }; } });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    h.restoreSessions([{ key, tasks: [{ id: 'p', original: 'Implement ORIGINAL', state: gate === 'stopped' ? 'stopped' : 'blocked',
      next: 'Untrusted next', depth: 0, explicitBlocked: true,
      recoveryEnrollment: gate === 'held-legacy' ? 'held-legacy' : 'current',
      ...(gate === 'expired' ? { expiresAt: 999 } : {}),
      supervisorDecision: { proposal: 'continue', verdict: gate === 'semantic-blocked' ? 'blocked' : 'unresolved' } }] }]);
    try {
      await h.recoverTasks();
      assert.equal(checks, 0);
      now += 60001;
      await h.recoverTasks(); h.releaseRestored(); await h.drained();
      assert.equal(checks, gate === 'none' ? 1 : 0);
      assert.equal(effects, gate === 'none' ? 1 : 0);
    } finally { await h.stop(0); }
  });
}
