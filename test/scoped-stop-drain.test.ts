import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Dispatcher, stopDispatcherParent } from '../src/dispatcher.js';
import { ExecutionStore } from '../src/execution.js';

function signal() {
 let resolve!: () => void;
 const promise = new Promise<void>(done => { resolve = done; });
 return { promise, resolve };
}

// Failure-only deadlock guard, not a stop latency requirement or a success timer.
async function guarded<T>(promise: Promise<T>): Promise<T> {
 let timer!: ReturnType<typeof setTimeout>;
 try {
  return await Promise.race([promise, new Promise<never>((_, reject) => {
   timer = setTimeout(() => reject(Error('scoped stop did not reach its causal barrier')), 5000);
  })]);
 } finally { clearTimeout(timer); }
}

async function fixture(t: { after(fn: () => unknown): void }) {
 const home = await mkdtemp(path.join(os.tmpdir(), 'scoped-stop-drain-')); t.after(() => rm(home, { recursive: true, force: true }));
 const file = path.join(home, 'executions.json');
 const store = new ExecutionStore(file); await store.load();
 const d = new Dispatcher(store, { name: 'test', version: 1, replaySafe: false, execute: async () => 'unused' }, 1, async () => {});
 return { d, store, file };
}

test('scoped parent stop and exact drain cannot be held by unrelated global scheduling', async t => {
 const { d, store } = await fixture(t);
 const owned = await store.submit('owner', 'owned', 'owned', 'test');
 const foreign = await store.submit('foreign', 'foreign', 'foreign', 'test');
 const global = signal();
 (d as any).scheduling = global.promise;
 d.kick = () => global.promise;
 const stopping = stopDispatcherParent(store, 'owner', d);
 try {
  // Completion itself proves independence while the unrelated barrier stays held.
  await guarded(stopping);
  assert.equal(store.list('owner')[0].id, owned.id); assert.equal(store.list('owner')[0].status, 'cancelled');
  assert.equal(store.list('foreign')[0].id, foreign.id); assert.equal(store.list('foreign')[0].status, 'ready');
 } finally { global.resolve(); await guarded(stopping); await guarded(d.stop()); }
});

test('scoped parent stop still waits for the actual owned worker settlement', async t => {
 const { d, store, file } = await fixture(t);
 const owned = await store.submit('owner', 'owned', 'owned', 'test');
 const foreign = await store.submit('foreign', 'foreign', 'foreign', 'test');
 const global = signal();
 (d as any).scheduling = global.promise;
 d.kick = () => global.promise;
 const done = signal();
 const abort = new AbortController(); (d as any).active.set(owned.id, { abort, done: done.promise });
 const commitEntered = signal(), allowCommit = signal(), revoked = signal(), aborted = signal(), drainEntered = signal();
 const cancelParent = store.cancelParent.bind(store);
 let committed = false, abortedBeforeCommit = false, draining = false;
 // Hold cancellation before its real durable mutation. No filesystem-speed assumption.
 store.cancelParent = async (...args) => {
  commitEntered.resolve();
  await allowCommit.promise;
  await cancelParent(...args);
  committed = true; revoked.resolve();
 };
 abort.signal.addEventListener('abort', () => {
  abortedBeforeCommit = !committed;
  aborted.resolve();
 }, { once: true });
 const drain = d.drainRevokedExecution.bind(d);
 d.drainRevokedExecution = id => {
  assert.equal(id, owned.id, 'only the revoked owner is drained');
  const pending = drain(id);
  draining = true; drainEntered.resolve();
  return pending;
 };
 let returned = false;
 const stopping = stopDispatcherParent(store, 'owner', d).then(() => { returned = true; });
 try {
  await guarded(commitEntered.promise);
  // Let runnable continuations finish without releasing the storage gate.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(abort.signal.aborted, false, 'no abort before durable revocation');
  assert.equal(draining, false, 'no drain before durable revocation');
  assert.equal(returned, false, 'stop waits for the held cancellation commit');
  assert.equal(store.list('owner')[0].status, 'ready');
  allowCommit.resolve();
  await guarded(Promise.all([revoked.promise, aborted.promise, drainEntered.promise]));
  assert.equal(abortedBeforeCommit, false, 'abort follows the completed durable mutation');
  // A fresh reader verifies the actual ledger, not just an in-memory spy signal.
  const persisted = new ExecutionStore(file); await persisted.load();
  assert.equal(persisted.list('owner')[0].id, owned.id); assert.equal(persisted.list('owner')[0].status, 'cancelled');
  assert.equal(persisted.list('foreign')[0].id, foreign.id); assert.equal(persisted.list('foreign')[0].status, 'ready');
  // Flush runnable stop continuations; the owned worker is still explicitly held.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(returned, false, 'abort and revocation do not substitute for worker settlement');
  done.resolve();
  await guarded(stopping); // The foreign global barrier is still unresolved here.
  assert.equal(returned, true);
 } finally {
  allowCommit.resolve(); done.resolve(); global.resolve();
  try { await guarded(stopping); }
  finally { (d as any).active.delete(owned.id); await guarded(d.stop()); }
 }
});
