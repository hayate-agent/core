import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness.js';
import { ExecutionStore } from '../src/execution.js';
import { DispatcherRuntime } from '../src/dispatcher-runtime.js';
import { OutboxDelivery, type OutboxEntry } from '../src/delivery/outbox.js';
import { FakeRuntime, MemoryChannel, msg, ROOM } from './fakes.js';

for (const legacy of [false, true]) test(`late result after restart: ${legacy ? 'legacy home fallback' : 'original address/context'}, not latest topic`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'result-anchor-'));
  const file = path.join(home, 'executions.json');
  let store = new ExecutionStore(file); await store.load();
  const original = { ...ROOM, thread: 'appointment' };
  const fallback = { ...ROOM, target: 'configured-home', thread: 'fallback' };
  const execution = await store.submit('mem:room1', 'request', 'appointment', 'direct', 1,
    { taskId: 'appointment', original: 'appointment', depth: 0,
      anchor: { id: 'appointment', task: 'appointment', receivedAt: 1, outputTags: ['appointments', 'incident-investigation'],
        ...(legacy ? {} : { replyTo: original }) } });
  const claim = await store.claim(execution.id);
  const workerKey = `dispatch:${execution.id}:${claim.token}`;
  await store.complete(execution.id, claim.token!, 'appointment result');
  store = new ExecutionStore(file); await store.load();
  const runtime = new FakeRuntime(() => 'answer'), channel = new MemoryChannel();
  const h = new Harness({ runtime, executionStore: store, hostEventAllowed: () => true, tickMs: 60000 });
  h.home = fallback; h.onStateChange = async () => {}; h.addChannel(channel); await h.start();
  t.after(async () => { await h.stop(1000); await rm(home, { recursive: true, force: true }); });
  await h.accept({ ...msg('security #security'), replyTo: { ...ROOM, thread: 'security' } });
  await h.waitForSessionIdle('mem:room1');
  const bridge = new DispatcherRuntime(h, store);
  // Completion clears the claim token; progress is claim-owned, not result-owned.
  assert.equal(bridge.approvalTarget(workerKey), undefined);
  await h.accept({ sessionKey: 'mem:room1', source: 'host', hostEvent: { executionId: execution.id },
    text: 'result #spoof', replyTo: { ...ROOM, thread: 'forged-host-destination' } });
  await h.waitForSessionIdle('mem:room1');
  assert.deepEqual(channel.sent.at(-1)!.to, legacy ? fallback : original);
  assert.equal(channel.sent.at(-1)!.text, '#appointments #incident-investigation · answer');
  assert.deepEqual(h.sessions.get('mem:room1')!.replyTo, { ...ROOM, thread: 'security' });
  if (legacy) {
    h.home = undefined;
    const before = channel.sent.length;
    await h.accept({ sessionKey: 'mem:room1', source: 'host', hostEvent: { executionId: execution.id }, text: 'legacy result' });
    await h.waitForSessionIdle('mem:room1');
    assert.equal(channel.sent.length, before, 'no home means local result, never latest topic');
  }
});

test('trusted channel anchor is cloned and exported in dependency checkpoint, not tool text', async t => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  h.onStateChange = async () => {}; await h.sessionFor('mem:room1');
  const session = (h.opts.runtime as FakeRuntime).sessions.get('mem:room1')!;
  const release = session.hold();
  t.after(async () => { release(); await h.stop(1000); });
  const to = { ...ROOM, thread: 'original' };
  await h.accept({ ...msg('work #appointments'), id: 'original', replyTo: to });
  for (let i = 0; i < 100 && !session.busy; i++) await new Promise(r => setTimeout(r, 5));
  to.thread = 'changed';
  assert.deepEqual(h.dependencyCheckpoint('mem:room1')!.anchor!.replyTo, { ...ROOM, thread: 'original' });
});

test('outbox restart/retry retains exact original destination, labels, progress and delivery ID', async () => {
  const to = { ...ROOM, thread: 'appointment' };
  const entry: OutboxEntry = { id: 'stable-delivery', sessionKey: 'parent', to, text: 'appointment result',
    outputTags: ['appointments'], progressId: 'appointment-progress' };
  const first = new OutboxDelivery({ deliver: async () => { throw Error('offline'); }, save: async () => {}, log: () => {} });
  assert.equal(await first.flush('parent', [entry]), false);
  const restored = JSON.parse(JSON.stringify([entry])) as OutboxEntry[];
  const second = new OutboxDelivery({ deliver: async (destination, text, meta) => {
    assert.deepEqual(destination, to); assert.equal(text, '#appointments · appointment result');
    assert.equal(meta.deliveryId, 'stable-delivery'); assert.equal(meta.progressId, 'appointment-progress');
  }, save: async () => {}, log: () => {} });
  assert.equal(await second.flush('parent', restored), true);
  assert.deepEqual(restored, []);
});
