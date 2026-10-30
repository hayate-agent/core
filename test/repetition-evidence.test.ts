import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { workingTreeEvidence } from '../src/repetition-budget.js';
import { ExecutionStore } from '../src/execution.js';
import { Harness, type DurableTask } from '../src/harness.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';

test('host Git evidence ignores arguments, untracked files and metadata, detects tracked bytes and cycles', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'repetition-'));
  try {
    assert.equal(await workingTreeEvidence(cwd), undefined);
    execFileSync('git', ['init', '-q'], { cwd });
    await writeFile(path.join(cwd, 'tracked'), 'a');
    execFileSync('git', ['add', 'tracked'], { cwd });
    const a = await workingTreeEvidence(cwd); assert.ok(a);
    await writeFile(path.join(cwd, 'untracked'), 'random');
    assert.equal(await workingTreeEvidence(cwd), a);
    await writeFile(path.join(cwd, 'tracked'), 'b');
    assert.notEqual(await workingTreeEvidence(cwd), a);
    await writeFile(path.join(cwd, 'tracked'), 'a');
    assert.equal(await workingTreeEvidence(cwd), a);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('serialized task beyond depth20 resumes once under original scope and retains evidence history', async () => {
  const task: DurableTask = { id: 't', original: 'original scope', state: 'active', depth: 35, next: 'check effect', expiresAt: 100000,
    repetition: { version: 1, repetitions: 0, attempts: 35, evidence: ['old'] } };
  let h: Harness; let calls = 0;
  const runtime = new FakeRuntime(text => {
    calls++; assert.match(text, /original scope/);
    h.planContinuation('mem:room1', { state: 'completed' }); return 'verified';
  });
  h = new Harness({ runtime, now: () => 1000 }); h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions(JSON.parse(JSON.stringify([{ key: 'mem:room1', tasks: [task], replyTo: { channel: 'mem', target: 'room1' } }])));
  await h.tick(); await h.drained(); await h.tick(); await h.drained();
  assert.equal(calls, 1);
  const result = h.snapshotSessions()[0]!.tasks![0]!;
  assert.equal(result.depth, 36); assert.equal(result.state, 'completed');
  assert.deepEqual(result.repetition?.evidence, ['old']);
});

test('overlapping host turns cannot credit another task tree change', async () => {
  let h: Harness; let tree = 0;
  let entered!: () => void; const first = new Promise<void>(resolve => entered = resolve);
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const runtime = new FakeRuntime((_text, key) => { tree++; h.planContinuation(key, { state: 'completed' }); return 'done'; });
  h = new Harness({ runtime, now: () => 1000, progressEvidence: async () => {
    if (tree === 0) { entered(); await gate; } return `tree${tree}`;
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.enqueue(msg('scope A', '@owner:x', 'mem:a'));
  await first;
  h.enqueue(msg('scope B', '@owner:x', 'mem:b'));
  await new Promise(resolve => setImmediate(resolve)); release();
  await h.drained();
  for (const session of h.snapshotSessions()) {
    assert.equal(session.tasks![0]!.repetition?.repetitions, 1);
  }
});


test('settled effect recovery restores accounting without model/effect replay', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'repetition-settled-'));
  try {
    const ledger = new ExecutionStore(path.join(home, 'ledger.json')); await ledger.load();
    await ledger.beginTurn('turn1', 'mem:room1');
    await ledger.settleTurn('turn1', 'mem:room1', { outbox: [], consumed: [], continuation: { state: 'completed' },
      repetition: { version: 1, repetitions: 3, attempts: 40, evidence: ['seen'] } });
    const runtime = new FakeRuntime(() => { throw Error('must not replay effect'); });
    const h = new Harness({ runtime, executionStore: ledger, now: () => 1000 });
    h.onStateChange = async () => {};
    h.restoreSessions([{ key: 'mem:room1', tasks: [{ id: 't', original: 'scope', state: 'active', depth: 35 }] }]);
    h.enqueue({ id: 'task:t:36', executionTurnId: 'turn1', taskId: 't', continuationDepth: 36,
      source: 'cron', sessionKey: 'mem:room1', text: 'retained step' });
    await h.drained();
    assert.equal(runtime.sessions.size, 0);
    const task = h.snapshotSessions()[0]!.tasks![0]!;
    assert.equal(task.state, 'completed'); assert.equal(task.repetition?.attempts, 40);
    assert.deepEqual(task.repetition?.evidence, ['seen']);
  } finally { await rm(home, { recursive: true, force: true }); }
});
