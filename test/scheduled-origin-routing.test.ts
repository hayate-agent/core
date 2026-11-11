import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness.js';
import { Dispatcher } from '../src/dispatcher.js';
import { ExecutionStore } from '../src/execution.js';
import { FakeRuntime, MemoryChannel } from './fakes.js';
import type { Address } from '../src/types.js';

// Each loop occurrence has its own mandate; delayed results still belong to its
// requesting room/thread, never the configured home or a later occurrence.
const A: Address = { channel: 'mem', target: 'roomA', thread: 'thread-a' };
const B: Address = { channel: 'mem', target: 'roomB' };

async function submitDuringLoop(h: Harness, runtime: FakeRuntime, dispatcher: Dispatcher, key: string, requestId: string) {
  await h.sessionFor(key);
  const session = runtime.sessions.get(key)!;
  const release = session.hold();
  h.enqueue({ sessionKey: key, source: 'loop', text: 'hourly overview' });
  for (let i = 0; i < 200 && !session.busy; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(h.sessions.get(key)!.current?.source, 'loop');
  assert.ok(h.dependencyCheckpoint(key)?.taskId, 'loop turn has its own host mandate');
  const execution = await dispatcher.submit(key, requestId, 'collect tickets');
  release(); await h.waitForSessionIdle(key);
  return execution;
}

for (const home of [undefined, { channel: 'mem', target: 'configured-home' }] as const)
  test(`loop-dispatched results return to requesting room/thread across restart (home ${home ? 'set' : 'unset'})`, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'origin-routing-'));
    const file = path.join(dir, 'executions.json');
    let store = new ExecutionStore(file); await store.load();
    const runtime = new FakeRuntime(() => 'NO_REPLY');
    const h = new Harness({ runtime, executionStore: store, tickMs: 60000 });
    h.home = home ? { ...home } : undefined; h.onStateChange = async () => {}; await h.start();
    h.state('mem:roomA').replyTo = A; h.state('mem:roomB').replyTo = B;
    const dispatcher = new Dispatcher(store, { name: 'direct', version: 1, replaySafe: false, execute: async () => 'worker result' },
      2, async () => {}, () => {}, key => h.dependencyCheckpoint(key), undefined, () => false, [], () => true, undefined, key => h.dispatchOrigin(key));
    await dispatcher.start();
    const ea = await submitDuringLoop(h, runtime, dispatcher, 'mem:roomA', 'a');
    const eb = await submitDuringLoop(h, runtime, dispatcher, 'mem:roomB', 'b');
    assert.deepEqual(store.list('mem:roomA')[0].origin, A);
    assert.deepEqual(store.list('mem:roomB')[0].origin, B);
    await dispatcher.stop(); await h.stop(1000);

    // Restart: fresh store/harness, sessions without remembered replyTo.
    store = new ExecutionStore(file); await store.load();
    const runtime2 = new FakeRuntime(() => 'overview ready'), channel = new MemoryChannel();
    const h2 = new Harness({ runtime: runtime2, executionStore: store, hostEventAllowed: () => true, tickMs: 60000 });
    h2.home = home ? { ...home } : undefined; h2.onStateChange = async () => {}; h2.addChannel(channel); await h2.start();
    t.after(async () => { await h2.stop(1000); await rm(dir, { recursive: true, force: true }); });
    for (const [key, id] of [['mem:roomB', eb.id], ['mem:roomA', ea.id]] as const) {
      await h2.accept({ sessionKey: key, source: 'host', hostEvent: { executionId: id }, text: 'result',
        replyTo: { channel: 'mem', target: 'forged' } });
      await h2.waitForSessionIdle(key);
    }
    assert.deepEqual(channel.sent.map(m => m.to), [B, A], 'each result in its own room, no cross-room leak, no home');
  });

test('explicit task anchor wins over origin; missing origin and home stays local', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'origin-routing-'));
  const store = new ExecutionStore(path.join(dir, 'executions.json')); await store.load();
  const anchored = await store.submit('mem:roomA', 'anchored', 'x', 'direct', 1,
    { taskId: 't', original: 'x', depth: 0, anchor: { id: 't', task: 'x', receivedAt: 1, replyTo: B } }, undefined, A);
  const bare = await store.submit('mem:roomA', 'bare', 'y', 'direct', 1);
  await assert.rejects(store.submit('mem:roomA', 'bad', 'z', 'direct', 1, undefined, undefined, { channel: 'mem' } as Address), /origin/);
  const channel = new MemoryChannel();
  const h = new Harness({ runtime: new FakeRuntime(() => 'done'), executionStore: store, hostEventAllowed: () => true, tickMs: 60000 });
  h.onStateChange = async () => {}; h.addChannel(channel); await h.start();
  h.state('mem:roomA').replyTo = A;
  t.after(async () => { await h.stop(1000); await rm(dir, { recursive: true, force: true }); });
  for (const id of [anchored.id, bare.id]) {
    await h.accept({ sessionKey: 'mem:roomA', source: 'host', hostEvent: { executionId: id }, text: 'result' });
    await h.waitForSessionIdle('mem:roomA');
  }
  assert.deepEqual(channel.sent.map(m => m.to), [B], 'anchor respected; unknown origin never guessed from session');
});
