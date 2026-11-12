import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.js';
import { FakeRuntime, MemoryChannel } from './fakes.js';

for (const diagnostic of ['technical', 'invalid_response'] as const) {
  test(`${diagnostic}: retry beyond three survives restart, respects backoff and requires admission`, async () => {
    let now = 100000, checks = 0;
    const key = 'mem:room1';
    const create = () => {
      const h = new Harness({ runtime: new FakeRuntime(), tickMs: 600000, now: () => now,
        completionCheck: async (_input, _reply, _signal, report) => {
          checks++;
          if (checks <= 5) { report?.(diagnostic); return undefined; }
          return { state: 'continue', next: 'Reconcile the existing result without replaying effects' };
        } });
      h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
      return h;
    };
    let h = create();
    h.restoreSessions([{ key, tasks: [{ id: 'p', original: 'Inspect the existing result', state: 'active', depth: 0 }] }]);
    try {
      for (let i = 1; i <= 5; i++) {
        await h.recoverTasks();
        assert.equal(checks, i);
        const task = h.state(key).tasks![0]!;
        assert.equal(task.state, 'active');
        assert.equal(task.termination, undefined);
        assert.equal(task.recoveryRetry?.attempts, i);
        assert.equal(task.recoveryAdmission, undefined);
        assert.equal(h.pendingInputs().length, 0);
        const due = task.recoveryRetry!.nextAt;
        assert.ok(due > now && due - now <= 3600000);
        const sessions = JSON.parse(JSON.stringify(h.snapshotSessions()));
        await h.stop(0);
        h = create(); h.restoreSessions(sessions);
        now = due - 1;
        await h.recoverTasks(); assert.equal(checks, i, 'no early assessment after restart');
        now = due;
      }
      await h.recoverTasks();
      assert.equal(checks, 6);
      const task = h.state(key).tasks![0]!;
      assert.equal(task.recoveryRetry, undefined);
      assert.ok(task.recoveryAdmission, 'only healthy checker admits productive continuation');
    } finally { await h.stop(0); }
  });
}
