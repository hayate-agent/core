import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Dispatcher, stopDispatcherParent } from '../src/dispatcher.js';
import { ExecutionStore } from '../src/execution.js';

async function fixture(t: { after(fn: () => unknown): void }) {
 const home = await mkdtemp(path.join(os.tmpdir(), 'scoped-stop-drain-')); t.after(() => rm(home, { recursive: true, force: true }));
 const store = new ExecutionStore(path.join(home, 'executions.json')); await store.load();
 const d = new Dispatcher(store, { name: 'test', version: 1, replaySafe: false, execute: async () => 'unused' }, 1, async () => {});
 return { d, store };
}

test('scoped parent stop and exact drain cannot be held by unrelated global scheduling', async t => {
 const { d, store } = await fixture(t);
 const owned = await store.submit('owner', 'owned', 'owned', 'test');
 const foreign = await store.submit('foreign', 'foreign', 'foreign', 'test');
 let release!: () => void; const global = new Promise<void>(resolve => { release = resolve; });
 (d as any).scheduling = global;
 d.kick = () => global;
 let finished = false;
 const stopping = stopDispatcherParent(store, 'owner', d).then(() => { finished = true; });
 let timer: ReturnType<typeof setTimeout> | undefined;
 try {
  // Test isolation from the STILL-held foreign scheduler, not whether durable
  // cancellation fsync happens within 30ms on a contended CI filesystem.
  const result = await Promise.race([stopping.then(() => 'settled'), new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked'), 2000); })]);
  assert.equal(result, 'settled', 'no unrelated global barrier in a scoped stop');
  assert.ok(finished);
  assert.equal(store.list('owner')[0].id, owned.id); assert.equal(store.list('owner')[0].status, 'cancelled');
  assert.equal(store.list('foreign')[0].id, foreign.id); assert.equal(store.list('foreign')[0].status, 'ready');
 } finally { clearTimeout(timer); release(); await stopping; await d.stop(); }
});

test('scoped parent stop still waits for the actual owned worker settlement', async t => {
 const { d, store } = await fixture(t); const owned = await store.submit('owner', 'owned', 'owned', 'test');
 let release!: () => void; const done = new Promise<void>(resolve => { release = resolve; });
 const abort = new AbortController(); (d as any).active.set(owned.id, { abort, done });
 let returned = false; const stopping = stopDispatcherParent(store, 'owner', d).then(() => { returned = true; });
 const deadline = Date.now() + 2000;
 while (!abort.signal.aborted && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
 assert.ok(abort.signal.aborted); assert.equal(returned, false);
 release(); await stopping; assert.equal(returned, true);
 (d as any).active.delete(owned.id); await d.stop();
});
