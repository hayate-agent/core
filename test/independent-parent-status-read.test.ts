import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness.js';
import { ExecutionStore } from '../src/execution.js';
import { toolGuardDenialReason } from '../src/tool-guard-error.js';
import { FakeRuntime } from './fakes.js';

async function fixture(t: { after(fn: () => unknown): void }) {
 const home = await mkdtemp(path.join(os.tmpdir(), 'independent-status-'));
 t.after(() => rm(home, { recursive: true, force: true }));
 const store = new ExecutionStore(path.join(home, 'executions.json')); await store.load();
 const child = await store.submit('mem:room1', 'child', 'Publish existing PR', 'direct', 1,
   { taskId: 'parent', depth: 0, original: 'Deliver reviewed integration' });
 const claim = await store.claim(child.id);
 await store.intent(child.id, claim.token!, 'publish', 'unsafe');
 await store.fail(child.id, claim.token!, 'HTTP 503');
 const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, now: () => 1000,
   completionCheck: async () => ({ state: 'continue', next: 'Inspect existing child status without replay' }) });
 h.onStateChange = async () => {};
 h.restoreSessions([{ key: 'mem:room1', task: { id: 'parent', original: 'Deliver reviewed integration',
   state: 'blocked', depth: 0, explicitBlocked: true }, replyTo: { channel: 'mem', target: 'room1' } }]);
 await h.recoverTasks();
 const input = h.pendingInputs()[0]; assert.ok(input);
 h.state('mem:room1').current = input;
 return { h, store, child, task: h.state('mem:room1').task! };
}

async function denied(fn: () => Promise<void>, code: string) {
 await assert.rejects(fn, error => toolGuardDenialReason(error).startsWith(code + ':'));
}

test('child snapshot changes do not revoke an exact scoped status read; effects and replay remain fenced', async t => {
 const { h, store, child } = await fixture(t);
 const list = store.list.bind(store);
 await h.guardWaitTool('mem:room1', 'plugin_dispatch', { action: 'status', id: child.id });
 // Model the scheduler changing its retry metadata during parent inference.
 store.list = parent => list(parent).map(row => row.id === child.id ? { ...row, workerRetry: { attempts: 2, nextAt: 5000 } } : row);
 await h.guardWaitTool('mem:room1', 'plugin_dispatch', { action: 'status', id: child.id, field: 'result' });
 await denied(() => h.guardWaitTool('mem:room1', 'bash', { command: 'publish' }), 'ownership_lost');
 for (const action of ['submit', 'resume', 'cancel', 'decide'])
   await denied(() => h.guardWaitTool('mem:room1', 'plugin_dispatch', { action, id: child.id }), 'ownership_lost');
 for (const args of [{ action: 'status' }, { action: 'status', id: 'other' }])
   await denied(() => h.guardWaitTool('mem:room1', 'plugin_dispatch', args), 'ownership_lost');
 assert.deepEqual(list(), store.list().map(row => { const copy = { ...row }; delete copy.workerRetry; return copy; }));
});

for (const fence of ['stopped', 'paused', 'expired', 'admission', 'foreign', 'cancelled-child', 'ownership-hold'] as const)
 test(`status exception cannot cross ${fence}`, async t => {
  const { h, store, child, task } = await fixture(t);
  const list = store.list.bind(store);
  store.list = parent => list(parent).map(row => ({ ...row, workerRetry: { attempts: 2, nextAt: 5000 },
    ...(fence === 'foreign' ? { dependency: { ...row.dependency!, taskId: 'different-parent' } } : {}),
    ...(fence === 'cancelled-child' ? { status: 'cancelled' as const } : {}),
    ...(fence === 'ownership-hold' ? { ownershipHold: true } : {}) }));
  if (fence === 'stopped') task.state = 'stopped';
  if (fence === 'paused') h.paused = true;
  if (fence === 'expired') task.expiresAt = 999;
  if (fence === 'admission') task.recoveryAdmission!.id = 'different-turn';
  await denied(() => h.guardWaitTool('mem:room1', 'plugin_dispatch', { action: 'status', id: child.id }),
    fence === 'stopped' || fence === 'paused' ? 'execution_cancelled' : fence === 'expired' ? 'deadline_expired' : 'ownership_lost');
 });

for (const change of ['completed', 'cancelled', 'foreign', 'missing'] as const)
 test(`changed ${change} child cannot release effects through empty pending set`, async t => {
  const { h, store, child } = await fixture(t);
  const list = store.list.bind(store);
  store.list = parent => change === 'missing' ? [] : list(parent).map(row => ({ ...row,
    ...(change === 'foreign' ? { dependency: { ...row.dependency!, taskId: 'different-parent' } } : { status: change }) }));
  for (const [tool, args] of [['bash', { command: 'publish' }], ['plugin_dispatch', { action: 'submit', task: 'new writer' }]] as const)
    await denied(() => h.guardWaitTool('mem:room1', tool, args), 'ownership_lost');
  if (change === 'completed')
    await h.guardWaitTool('mem:room1', 'plugin_dispatch', { action: 'status', id: child.id, field: 'result' });
  else
    await denied(() => h.guardWaitTool('mem:room1', 'plugin_dispatch', { action: 'status', id: child.id }), 'ownership_lost');
 });
