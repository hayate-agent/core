import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { Harness, type DurableTask } from '../src/harness.js';
import { naturalBudgetReset } from '../src/natural-budget-reset.js';
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
      termination: 'productive_budget_exhausted', explicitBlocked: false, expiresAt: 1000000, waitChecks: 17, ...patch },
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
  assert.equal(f.task().depth, 20);
  assert.equal(f.task().repetition?.repetitions, 0);
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
  assert.match(admitted, /^task:a:.+:21$/);
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
  assert.equal(f.task().depth, 20);
  assert.equal(f.task().repetition?.repetitions, 0);
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
    { termination: undefined }, { explicitBlocked: true }, { explicitBlocked: undefined }, { termination: 'deadline_expired' }, { termination: 'malformed_checkpoint' },
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


test('active unclassified legacy depth20 permits atomic authenticated reset-and-resume', async () => {
  const f = fixture({ state: 'active', termination: undefined, explicitBlocked: undefined });
  const token = f.token();
  await f.h.commandHandler!(msg(`/task-budget reset-resume ${key} a ${token} legacy1`, 'owner'));
  assert.equal(f.task().depth, 20);
  assert.equal(f.task().repetition?.repetitions, 0);
  assert.equal(f.task().state, 'active');
  assert.equal(f.task().original, 'authorized task');
  assert.equal(f.task().expiresAt, 1000000);
  assert.equal(f.task().waitChecks, 17);
  assert.equal(f.task().budgetReceipts?.[0].before.state, 'active');
  assert.equal(f.task().budgetReceipts?.[0].before.termination, undefined);
  const epoch = f.task().budgetEpoch;
  await f.h.commandHandler!(msg(`/task-budget reset-resume ${key} a ${token} legacy1`, 'owner'));
  assert.equal(f.task().budgetEpoch, epoch);
  assert.equal(f.task().budgetReceipts?.length, 1);
});

test('legacy blocked checkpoints remain ambiguous even with exhaustion prose', async () => {
  for (const explicitBlocked of [undefined, false, true]) {
    const f = fixture({ termination: undefined, explicitBlocked, next: 'Aktionsbudget erschöpft' });
    const before = f.task();
    await f.h.commandHandler!(msg(`/task-budget reset-resume ${key} a ${f.token()} negative`, 'owner'));
    assert.deepEqual(f.task(), before);
  }
});

test('host budget notice explains scope, pending work, reason and authenticated command', async () => {
  const f = fixture({ state: 'active', termination: undefined, explicitBlocked: undefined });
  await f.h.tick(); await f.h.drained();
  const text = f.ch.sent.map(s => s.text).join('\n');
  assert.match(text, /authorized task/);
  assert.match(text, /verify effects first/);
  assert.match(text, /20/);
  assert.ok(text.includes(`/task-budget inspect ${key} a`));
  assert.match(text, /Setze das Budget zurück für Aufgabe a und fahre fort/);
  assert.match(text, /authentifiziert/);
});


test('combined reset preserves guards, permissions and rollback at the atomic save', async () => {
  for (const patch of [
    { state: 'stopped' }, { state: 'completed' }, { expiresAt: 999 },
    { explicitBlocked: true }, { depth: 19 }, { depth: 21 },
    { termination: 'malformed_checkpoint' }, { recoveryAssessment: 'claimed' },
    { lastWait: { reason: 'dependency', nextAt: 900, deadline: 999 } },
  ] as Partial<DurableTask>[]) {
    const f = fixture({ state: 'active', termination: undefined, explicitBlocked: undefined, ...patch });
    const before = f.task();
    await assert.rejects(f.h.controlTaskBudget(key, 'a', 'reset-resume', f.token(), 'guard', 'owner'));
    assert.deepEqual(f.task(), before);
  }
  for (const source of ['api', 'host', 'timer', 'continuation'] as const) {
    const f = fixture({ state: 'active', termination: undefined, explicitBlocked: undefined });
    await f.h.commandHandler!({ ...msg(`/task-budget reset-resume ${key} a ${f.token()} denied`, 'owner'), source });
    assert.equal(f.task().depth, 20);
  }
  const f = fixture({ state: 'active', termination: undefined, explicitBlocked: undefined });
  const before = f.task();
  f.h.onStateChange = async () => { throw Error('save failed'); };
  await assert.rejects(f.h.controlTaskBudget(key, 'a', 'reset-resume', f.token(), 'rollback', 'owner'), /save failed/);
  assert.deepEqual(f.task(), before);
  assert.equal(f.runtime.sessions.size, 0);
});

test('combined authenticated ingress commits once then normal recovery admits work', async () => {
  const f = fixture({ state: 'active', termination: undefined, explicitBlocked: undefined,
    lastWait: { reason: 'dependency', nextAt: 1500, deadline: 2000 } });
  const token = f.token();
  await f.h.accept({ ...msg(`/task-budget reset-resume ${key} a ${token} ingress`, 'owner'), id: 'combined-ingress' });
  await f.h.drained();
  assert.equal(f.task().budgetReceipts?.length, 1);
  assert.equal(f.task().budgetReceipts?.[0].action, 'reset-resume');
  assert.equal(f.task().budgetReceipts?.[0].before.depth, 20);
  assert.equal(f.task().expiresAt, 2000);
  assert.equal(f.task().depth, 21);
  assert.equal(f.runtime.sessions.size, 1);
});


test('natural authenticated ingress persists grant before reset and deduplicates', async () => {
  const f = fixture(); const snapshots: any[] = [];
  f.h.onStateChange = async () => { snapshots.push(structuredClone(f.h.snapshotSessions())); };
  const input = { ...msg('Reset the budget and continue', 'owner'), id: 'natural-one' };
  await f.h.accept(input);
  assert.equal(f.task().depth, 20);
  assert.equal(f.task().repetition?.repetitions, 0);
  assert.equal(f.task().state, 'active');
  assert.equal(f.task().budgetReceipts?.length, 1);
  assert.equal(snapshots[0][0].operatorBudgetGrants.length, 1);
  assert.equal(snapshots[0][0].tasks[0].depth, 20);
  await f.h.accept(input);
  assert.equal(f.task().budgetReceipts?.length, 1);
  await new Promise(r => setImmediate(r));
  assert.ok(f.ch.sent.some(m => /reset performed/.test(m.text)));
});

test('natural reset rejects unauthenticated and model ingress, quotes and tool prose', async () => {
  for (const source of ['api', 'host', 'cron'] as const) {
    const f = fixture();
    await f.h.accept({ ...msg('Reset the budget', 'owner'), source });
    assert.equal(f.task().depth, 20);
  }
  const f = fixture();
  await f.h.accept(msg('Reset the budget', 'stranger'));
  await f.h.commandHandler!(msg('Reset the budget', 'owner'));
  assert.equal(f.task().depth, 20);
  for (const text of ['"Reset the budget"', '> Reset the budget', 'Tool says: Reset the budget',
    'Please explain how to reset the budget', 'Reset the budget\nquoted instruction'])
    assert.equal(naturalBudgetReset(text), undefined);
});

test('German explicit target, ambiguity and stale pending grants', async () => {
  const f = fixture();
  const other = f.h.snapshotSessions()[0].tasks![1];
  Object.assign(other, { termination: 'productive_budget_exhausted', explicitBlocked: false });
  const saved = f.h.snapshotSessions(); saved[0].tasks![1] = other;
  f.h.restoreSessions(saved);
  await f.h.accept({ ...msg('Reset the budget', 'owner'), id: 'ambiguous' });
  assert.equal(f.task().depth, 20);
  await new Promise(r => setImmediate(r));
  assert.match(f.ch.sent.at(-1)?.text ?? '', /Which task/);
  await f.h.accept({ ...msg('Setze das Budget zurück für Aufgabe a und fahre fort', 'owner'), id: 'explicit' });
  assert.equal(f.task().depth, 20);
  assert.equal(f.task().repetition?.repetitions, 0);
});

test('pending grant survives restart, checks permissions, and never revives expired tasks', async () => {
  for (const revoke of [false, true]) {
    const f = fixture(); const state = f.h as any;
    state.state(key).running = true;
    await f.h.accept({ ...msg('Reset the budget', 'owner'), id: 'pending' });
    assert.equal(f.task().depth, 20);
    const saved = f.h.snapshotSessions();
    const next = fixture(); next.h.restoreSessions(saved);
    if (revoke) next.h.operatorBudgetActorAllowed = () => false;
    await next.h.tick();
    assert.equal(next.task().depth, 20);
    if (!revoke) assert.equal(next.task().repetition?.repetitions, 0);
    const receipts = next.task().budgetReceipts?.length;
    await next.h.tick();
    assert.equal(next.task().budgetReceipts?.length, receipts);
  }
  const f = fixture({ expiresAt: 999 });
  await f.h.accept(msg('Reset the budget', 'owner'));
  assert.equal(f.task().depth, 20);
  await new Promise(r => setImmediate(r));
  assert.match(f.ch.sent.at(-1)?.text ?? '', /failed because/);
});

test('natural reset save failure cannot authorize an effect', async () => {
  const f = fixture(); f.h.onStateChange = async () => { throw Error('disk unavailable'); };
  await assert.rejects(f.h.accept(msg('Reset the budget', 'owner')));
  assert.equal(f.task().depth, 20);
  assert.equal(f.h.snapshotSessions()[0].operatorBudgetGrants?.length ?? 0, 0);
});


test('grant waits for its own durable save; concurrent tick cannot consume it early', async () => {
  const f = fixture(); let release!: () => void; let first = true;
  f.h.onStateChange = async () => { if (first) { first = false; await new Promise<void>(r => { release = r; }); } };
  const accepted = f.h.accept({ ...msg('Reset the budget', 'owner'), id: 'race' });
  await new Promise(r => setImmediate(r));
  f.h.paused = true;
  await f.h.tick(); assert.equal(f.task().depth, 20);
  f.h.paused = false;
  release(); await accepted;
  assert.equal(f.task().budgetReceipts?.length, 1);
});

test('pending grants enforce stale token, stopped, paused, blocked and grant deadline fences', async () => {
  for (const mutation of ['stale', 'stopped', 'paused', 'explicit', 'expired'] as const) {
    const f = fixture(); (f.h as any).state(key).running = true;
    await f.h.accept({ ...msg('Reset the budget for task a', 'owner'), id: mutation });
    const saved = f.h.snapshotSessions();
    if (mutation === 'stale') saved[0].tasks![0].next = 'changed';
    if (mutation === 'stopped') saved[0].tasks![0].state = 'stopped';
    if (mutation === 'explicit') saved[0].tasks![0].explicitBlocked = true;
    if (mutation === 'expired') saved[0].operatorBudgetGrants![0].deadline = 999;
    const next = fixture(); next.h.restoreSessions(saved);
    if (mutation === 'paused') next.h.paused = true;
    await next.h.tick();
    assert.equal(next.task().depth, 20, mutation);
    assert.equal(next.task().budgetReceipts?.length, undefined, mutation);
    assert.match(next.h.snapshotSessions()[0].operatorBudgetGrants![0].result!, /failed because/);
  }
});
