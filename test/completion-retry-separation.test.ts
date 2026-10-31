import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness, type DurableTask } from '../src/harness.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';

const key = 'mem:room1';
const retained = (): DurableTask => ({ id: 't', original: 'Verify the authorized change', state: 'active', depth: 2 });

for (const prior of [0, 2]) test(`successful recovery nudge clears failure reservation (${prior} prior attempts), including persisted admission`, async () => {
  const task = retained();
  if (prior) task.recoveryRetry = { attempts: prior, nextAt: 0 };
  const h = new Harness({ runtime: new FakeRuntime(), now: () => 1000,
    completionCheck: async () => ({ state: 'continue', next: 'Inspect actual test evidence', contextPreparation: 'compact' }) });
  h.onStateChange = async () => {};
  h.restoreSessions([{ key, tasks: [task] }]);
  try {
    await h.recoverTasks();
    const home = await mkdtemp(path.join(os.tmpdir(), 'completion-retry-'));
    let sessions;
    try {
      const file = path.join(home, 'sessions.json');
      await writeFile(file, JSON.stringify(h.snapshotSessions()));
      sessions = JSON.parse(await readFile(file, 'utf8'));
    } finally { await rm(home, { recursive: true, force: true }); }
    const saved = sessions[0].tasks[0] as DurableTask;
    assert.equal(saved.recoveryRetry, undefined, 'a valid semantic continue is not a failed recovery operation');
    assert.equal(saved.recoveryAssessment, 'decided');
    assert.equal(saved.contextPreparation, 'compact');
    assert.ok(saved.recoveryAdmission);
    assert.equal(saved.depth, 2);
    const next = new Harness({ runtime: new FakeRuntime(), now: () => 1000,
      completionCheck: async () => { throw Error('must use persisted admission, not reassess'); } });
    next.onStateChange = async () => {};
    try {
      next.restoreSessions(sessions); await next.recoverTasks();
      assert.equal(next.pendingInputs().length, 1);
      assert.equal(next.pendingInputs()[0].contextPreparation, 'compact');
      assert.equal(next.snapshotSessions()[0].tasks![0].recoveryRetry, undefined);
    } finally { await next.stop(0); }
  } finally { await h.stop(0); }
});

for (const failure of ['undefined', 'error'] as const) test(`actual ${failure} recovery failures retain three-attempt limit and 60s backoff across restart`, async () => {
  let now = 1000, calls = 0;
  let sessions = [{ key, tasks: [retained()] }];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const h = new Harness({ runtime: new FakeRuntime(), now: () => now,
      completionCheck: async () => { calls++; if (failure === 'error') throw Error('provider unavailable'); return undefined; } });
    h.onStateChange = async () => {};
    try {
      h.restoreSessions(sessions); await h.recoverTasks();
      assert.equal(calls, attempt);
      await h.recoverTasks(); assert.equal(calls, attempt);
      const saved = h.snapshotSessions()[0].tasks![0];
      assert.equal(saved.recoveryRetry?.attempts, attempt);
      assert.equal(saved.recoveryRetry?.nextAt, now + 60000);
      assert.equal(saved.state, attempt === 3 ? 'blocked' : 'active');
      sessions = JSON.parse(JSON.stringify(h.snapshotSessions()));
    } finally { await h.stop(0); }
    now += 60000;
  }
  const h = new Harness({ runtime: new FakeRuntime(), now: () => now,
    completionCheck: async () => { calls++; return { state: 'continue', next: 'not authorized by exhaustion' }; } });
  h.onStateChange = async () => {};
  try { h.restoreSessions(sessions); await h.recoverTasks(); assert.equal(calls, 3); assert.equal(h.pendingInputs().length, 0); }
  finally { await h.stop(0); }
});

test('ordinary semantic nudges and productive followups do not create recovery retries across persisted checkpoints', async () => {
  let turns = 0, checks = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return 'Analysis step verified'; }),
    completionCheck: async () => { checks++; return turns < 12 ? { state: 'continue', next: 'Continue the authorized analysis' } : { state: 'completed' }; } });
  h.addChannel(new MemoryChannel());
  h.onStateChange = async () => {
    for (const session of JSON.parse(JSON.stringify(h.snapshotSessions())))
      for (const task of session.tasks ?? []) assert.equal(task.recoveryRetry, undefined);
  };
  try {
    await h.accept(msg('Perform the authorized multi-step analysis')); await h.drained();
    assert.equal(turns, 12); assert.equal(checks, 12);
    const saved = JSON.parse(JSON.stringify(h.snapshotSessions()));
    assert.equal(saved[0].tasks[0].state, 'completed');
    assert.equal(saved[0].tasks[0].recoveryRetry, undefined);
  } finally { await h.stop(0); }
});
