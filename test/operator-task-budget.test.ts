import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { Harness, type DurableTask } from '../src/harness.js';
import { installCommands } from '../src/commands.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';

const key = 'mem:room1';
function fixture(patch: Partial<DurableTask> = {}) {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, now: () => 1000 });
  const ch = new MemoryChannel(); h.addChannel(ch);
  h.onStateChange = async () => {};
  h.restoreSessions([{ key, replyTo: { channel: 'mem', target: 'room1' }, tasks: [
    { id: 'a', original: 'authorized task', state: 'blocked', depth: 20, next: 'verify effects first',
      termination: 'productive_budget_exhausted', expiresAt: 1000000, waitChecks: 17, ...patch },
    { id: 'other', original: 'unrelated', state: 'blocked', depth: 20 },
  ] }]);
  installCommands({ harness: h, admins: ['owner'], openAdmin: false, approvals: { mode: 'off', tools: [] },
    agent: 'test', skills: () => [], reloadSkills: async () => {}, restart: async () => {} });
  return { h, ch, runtime, token: () => h.taskBudgetStatus(key, 'a').token,
    task: () => h.taskBudgetStatus(key, 'a').task };
}

test('capability reproduction: exhausted checkpoint cannot recover without operator command', async () => {
  const f = fixture();
  await f.h.recoverTasks(); await f.h.drained();
  assert.equal(f.runtime.sessions.size, 0);
  assert.equal(f.task().depth, 20);
});

test('authenticated ingress reset and separate resume, exact scope, serialized restart and old dedup retained', async () => {
  const f = fixture();
  const token = f.token();
  f.h.restoreSeen(['old-effect', 'task:a:1']);
  await f.h.accept({ ...msg(`/task-budget reset ${key} a ${token} req1`, 'owner'), id: 'operator1' });
  await f.h.drained();
  assert.equal(f.task().depth, 0);
  assert.equal(f.task().state, 'blocked');
  assert.equal(f.task().waitChecks, 17);
  assert.equal(f.task().expiresAt, 1000000);
  assert.equal(f.h.taskBudgetStatus(key, 'other').task.depth, 20);
  assert.equal(f.task().budgetReceipts?.[0].before.depth, 20);
  assert.equal(f.runtime.sessions.size, 0);
  const saved = JSON.parse(JSON.stringify(f.h.snapshotSessions()));
  const restarted = fixture(); restarted.h.restoreSessions(saved); restarted.h.restoreSeen(f.h.seenIds());
  await restarted.h.recoverTasks(); assert.equal(restarted.runtime.sessions.size, 0);
  await restarted.h.controlTaskBudget(key, 'a', 'reset', token, 'req1', 'mem:owner');
  assert.equal(restarted.task().budgetReceipts?.length, 1);
  const nextToken = restarted.token();
  await restarted.h.controlTaskBudget(key, 'a', 'resume', nextToken, 'resume1', 'mem:owner');
  assert.equal(restarted.task().state, 'active');
  assert.ok(restarted.h.seenIds().includes('task:a:1'));
  // On restart only the newly namespaced continuation is admitted, not the old accepted ID.
  const third = fixture(); third.h.restoreSessions(JSON.parse(JSON.stringify(restarted.h.snapshotSessions())));
  third.h.restoreSeen(restarted.h.seenIds());
  let admitted = '';
  third.h.onStateChange = async () => { admitted ||= third.h.pendingInputs()[0]?.id ?? ''; };
  await third.h.recoverTasks(); third.h.releaseRestored(); await third.h.drained();
  assert.match(admitted, /^task:a:.+:1$/);
  assert.ok(third.runtime.sessions.size > 0);
});

test('remote nonadmin, senderless open-admin and model/API/host invocation cannot reset', async () => {
  for (const [source, sender] of [['channel', 'other'], ['channel', undefined], ['api', 'owner'], ['host', 'owner'], ['cron', 'owner']] as const) {
    const f = fixture();
    const input = { ...msg(`/task-budget reset ${key} a ${f.token()} r`, sender), source };
    // Exercise the command handler directly as well: authority must not depend on routing alone.
    await f.h.commandHandler!(input);
    assert.equal(f.task().depth, 20);
  }
  const f = fixture();
  await f.h.commandHandler!({ ...msg(`/task-budget reset ${key} a ${f.token()} local`), replyTo: { channel: 'console', target: 'local' } });
  assert.equal(f.task().depth, 0);
});

test('persistence failure rolls back, concurrent stale requests do not renew twice', async () => {
  const f = fixture(); const original = f.task(); const token = f.token();
  f.h.onStateChange = async () => { throw Error('disk offline'); };
  await assert.rejects(f.h.controlTaskBudget(key, 'a', 'reset', token, 'r', 'owner'), /disk offline/);
  assert.deepEqual(f.task(), original);
  let release!: () => void;
  f.h.onStateChange = () => new Promise<void>(r => { release = r; });
  const pending = f.h.controlTaskBudget(key, 'a', 'reset', token, 'r', 'owner');
  await assert.rejects(f.h.controlTaskBudget(key, 'a', 'reset', token, 'other', 'owner'), /idle/);
  await f.h.tick(); assert.equal(f.runtime.sessions.size, 0);
  await assert.rejects(f.h.stopConversation(key), /retry stop/);
  release(); await pending;
  await assert.rejects(f.h.controlTaskBudget(key, 'a', 'reset', token, 'other', 'owner'), /Stale/);
  assert.equal(f.task().budgetReceipts?.length, 1);
});

test('no resurrection of stopped/completed/expired/explicit blocked or paused tasks', async () => {
  for (const patch of [
    { state: 'stopped' }, { state: 'completed' }, { expiresAt: 999 },
    { termination: undefined }, { explicitBlocked: true }, { termination: 'deadline_expired' }, { termination: 'malformed_checkpoint' },
  ] as Partial<DurableTask>[]) {
    const f = fixture(patch);
    await assert.rejects(f.h.controlTaskBudget(key, 'a', 'reset', f.token(), 'r', 'owner'));
    assert.equal(f.task().depth, 20);
  }
  const f = fixture(); f.h.paused = true;
  await assert.rejects(f.h.controlTaskBudget(key, 'a', 'reset', f.token(), 'r', 'owner'));
});

test('three real recovery failures classify exhaustion; reset preserves productive count and audits attempts', async () => {
  const runtime = new FakeRuntime(); let now = 1000;
  const h = new Harness({ runtime, now: () => now, completionCheck: async () => { throw Error('assessment failed'); } });
  h.onStateChange = async () => {};
  h.restoreSessions([{ key, tasks: [{ id: 'a', original: 'work', state: 'active', depth: 5 }] }]);
  for (let i = 0; i < 3; i++) { await h.recoverTasks(); now += 61000; }
  let status = h.taskBudgetStatus(key, 'a');
  assert.equal(status.task.recoveryRetry?.attempts, 3);
  assert.equal(status.task.termination, 'recovery_assessment_failed');
  await h.controlTaskBudget(key, 'a', 'reset', status.token, 'recovery', 'owner');
  status = h.taskBudgetStatus(key, 'a');
  assert.equal(status.task.depth, 5);
  assert.equal(status.task.recoveryRetry, undefined);
  assert.equal(status.task.budgetReceipts?.[0].before.recoveryRetry?.attempts, 3);
  assert.equal(status.task.state, 'blocked');
});


test('atomic StateStore persistence roundtrip keeps audit, deadline, scope and idempotency', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'operator-budget-'));
  try {
    const store = new StateStore(path.join(dir, 'state.json'));
    const f = fixture({ lastWait: { reason: 'dependency', nextAt: 2000, deadline: 5000 } });
    f.h.onStateChange = () => store.save({ version: 1, paused: false, busyMode: 'queue', sessions: f.h.snapshotSessions(), seen: f.h.seenIds() });
    const token = f.token();
    await f.h.controlTaskBudget(key, 'a', 'reset', token, 'reset-disk', 'owner');
    const loaded = await new StateStore(store.file).load();
    const second = fixture(); second.h.restoreSessions(loaded!.sessions);
    await second.h.controlTaskBudget(key, 'a', 'reset', token, 'reset-disk', 'owner');
    await second.h.controlTaskBudget(key, 'a', 'resume', second.token(), 'resume-disk', 'owner');
    assert.equal(second.task().expiresAt, 5000);
    assert.equal(second.task().budgetReceipts?.length, 2);
    assert.equal(second.task().original, 'authorized task');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('real productive twentieth continuation is resettable but explicit blocked twentieth is not', async () => {
  for (const state of ['continue', 'blocked'] as const) {
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime });
    h.addChannel(new MemoryChannel());
    runtime.answer = () => { h.planContinuation(key, { state, next: 'verify before acting' }); return 'checkpoint'; };
    h.onStateChange = async () => {};
    h.restoreSessions([{ key, tasks: [{ id: 'a', original: 'work', state: 'active', depth: 19 }] }]);
    await h.submit({ ...msg('twentieth'), source: 'cron', taskId: 'a', continuationDepth: 20 });
    await h.drained();
    const status = h.taskBudgetStatus(key, 'a');
    assert.equal(status.task.depth, 20);
    assert.equal(status.task.termination, 'productive_budget_exhausted');
    const reset = h.controlTaskBudget(key, 'a', 'reset', status.token, 'twenty', 'owner');
    if (state === 'continue') await reset;
    else await assert.rejects(reset, /not host budget-blocked/);
  }
});

test('openAdmin alone is insufficient and failed resume cannot release execution', async () => {
  const f = fixture();
  installCommands({ harness: f.h, admins: [], openAdmin: true, approvals: { mode: 'off', tools: [] },
    agent: 'test', skills: () => [], reloadSkills: async () => {}, restart: async () => {} });
  await f.h.commandHandler!(msg(`/task-budget reset ${key} a ${f.token()} remote`, 'stranger'));
  assert.equal(f.task().depth, 20);
  await f.h.drained();
  await f.h.controlTaskBudget(key, 'a', 'reset', f.token(), 'reset', 'owner');
  const before = f.task();
  f.h.onStateChange = async () => { throw Error('cannot persist resume'); };
  await assert.rejects(f.h.controlTaskBudget(key, 'a', 'resume', f.token(), 'resume', 'owner'), /cannot persist/);
  assert.deepEqual(f.task(), before);
  await f.h.recoverTasks();
  assert.equal(f.runtime.sessions.size, 0);
});
