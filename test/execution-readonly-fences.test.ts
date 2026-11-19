import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExecutionStore, ExecutionDecisionConflict } from '../src/execution.js';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'decision-readonly-')); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'executions.json'), store = new ExecutionStore(file); await store.load();
  const task = await store.submit('parent', 'original', 'Original mandate, retain uncertain effects', 'sequential');
  const claim = await store.claim(task.id);
  const storage = (store as any).storage, save = storage.save.bind(storage); let saves = 0;
  storage.save = async (...args: unknown[]) => { saves++; return save(...args); };
  return { home, file, store, task, claim, storage, saves: () => saves };
}

test('repeated read-only fences and empty/already-applied consumption do not rewrite the ledger', async t => {
  const f = await fixture(t), before = await readFile(f.file);
  for (let i = 0; i < 8; i++) {
    await f.store.fenceDecisions(f.task.id, f.claim.token!, 0);
    assert.deepEqual(await f.store.applyDecisions(f.task.id, f.claim.token!), []);
  }
  assert.equal(f.saves(), 0); assert.deepEqual(await readFile(f.file), before);
  await f.store.recordDecision('parent', f.task.id, 'new', 'Scoped operator context, not effect replay');
  const count = f.saves();
  const first = await f.store.applyDecisions(f.task.id, f.claim.token!);
  assert.equal(f.saves(), count + 1); assert.equal(first[0]!.state, 'applied');
  const appliedBytes = await readFile(f.file);
  const again = await f.store.applyDecisions(f.task.id, f.claim.token!);
  assert.deepEqual(again, first); assert.equal(f.saves(), count + 1); assert.deepEqual(await readFile(f.file), appliedBytes);
  again[0]!.text = 'mutated caller copy';
  assert.equal(f.store.list()[0]!.decisions![0]!.text, first[0]!.text);
  const reloaded = new ExecutionStore(f.file); await reloaded.load(); assert.deepEqual(reloaded.list()[0]!.decisions, first);
});

test('a preceding queued decision is observed before a read-only revision fence or consumption', async t => {
  const f = await fixture(t);
  const pending = f.store.recordDecision('parent', f.task.id, 'new', 'New scoped operator context');
  const staleFence = f.store.fenceDecisions(f.task.id, f.claim.token!, 0);
  await assert.rejects(staleFence, ExecutionDecisionConflict); await pending;
  const count = f.saves(); await f.store.fenceDecisions(f.task.id, f.claim.token!, 1); assert.equal(f.saves(), count);
  const applied = await f.store.applyDecisions(f.task.id, f.claim.token!); assert.equal(applied[0]!.state, 'applied'); assert.equal(f.saves(), count + 1);
});

test('failed consumption commit is not adopted and retry must durably apply the original decision', async t => {
  const f = await fixture(t); await f.store.recordDecision('parent', f.task.id, 'new', 'Original exact steering');
  const save = f.storage.save.bind(f.storage); let fail = true;
  f.storage.save = async (...args: unknown[]) => { if (fail) throw Error('injected commit failure'); return save(...args); };
  await assert.rejects(f.store.applyDecisions(f.task.id, f.claim.token!), /injected commit failure/);
  assert.equal(f.store.list()[0]!.decisions![0]!.state, 'pending');
  fail = false; const applied = await f.store.applyDecisions(f.task.id, f.claim.token!); assert.equal(applied[0]!.state, 'applied');
  const reloaded = new ExecutionStore(f.file); await reloaded.load(); assert.deepEqual(reloaded.list()[0]!.decisions, applied);
});

test('no-op fences preserve writer fencing even when no mutation would be committed', async t => {
  const f = await fixture(t); f.storage.assertWritable = () => { throw Error('owner lost or publication uncertain'); };
  await assert.rejects(f.store.fenceDecisions(f.task.id, f.claim.token!, 0), /owner lost/);
  await assert.rejects(f.store.applyDecisions(f.task.id, f.claim.token!), /owner lost/);
  assert.equal(f.saves(), 0);
});

test('queued cancellation revokes ownership before either read-only path and uncertain intent remains exact', async t => {
  const f = await fixture(t);
  await f.store.intent(f.task.id, f.claim.token!, 'uncertain-original', 'unsafe', { model: 'configured/exact' }, 0);
  const intent = f.store.list()[0]!.intent;
  const cancellation = f.store.cancelParent('parent');
  const fence = f.store.fenceDecisions(f.task.id, f.claim.token!, 0);
  const apply = f.store.applyDecisions(f.task.id, f.claim.token!);
  await cancellation; await assert.rejects(fence, /Stale execution claim/); await assert.rejects(apply, /Stale execution claim/);
  assert.deepEqual(f.store.list()[0]!.intent, intent); assert.equal(f.store.list()[0]!.parentStopped, true);
  const count = f.saves();
  await assert.rejects(f.store.fenceDecisions(f.task.id, 'stale', 0), /Stale execution claim/); assert.equal(f.saves(), count);
});
