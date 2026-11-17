import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.js';
import { Scheduler } from '../src/scheduler.js';
import { OutboxDelivery, retryAfterMs, type OutboxEntry } from '../src/delivery/outbox.js';
import { PermanentDeliveryError } from '../src/types.js';
import { FakeRuntime, MemoryChannel } from './fakes.js';

test('hourly cron run executes exactly once even when the model proposes a continuation', async () => {
  let h: Harness; let turns = 0;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    h.planContinuation(key, { state: 'continue', next: `look again ${turns}` });
    return 'overview';
  });
  h = new Harness({ runtime, now: () => 1000, tickMs: 60000, completionCheck: async () => ({ state: 'continue', next: 'again' }) });
  const channel = new MemoryChannel();
  h.addChannel(channel); h.onStateChange = async () => {};
  const scheduler = new Scheduler(h, { timezone: 'UTC' });
  await scheduler.runJob({ name: 'hourly', schedule: '20 * * * *', prompt: 'Overview', audience: 'user', deliver: 'mem:room1' });
  await h.waitForSessionIdle('cron:hourly'); await h.drained();
  await h.tick(); await h.drained();
  assert.equal(turns, 1);
  assert.equal(channel.sent.length, 1);
});

test('retryAfterMs reads the Matrix M_LIMIT_EXCEEDED hint and caps it', () => {
  assert.equal(retryAfterMs(new Error('PUT /x: HTTP 429 {"errcode":"M_LIMIT_EXCEEDED","retry_after_ms":2838}')), 2838);
  assert.equal(retryAfterMs(new Error('HTTP 429 {"retry_after_ms":9999999}')), 60000);
  assert.equal(retryAfterMs(new Error('HTTP 500')), undefined);
});

test('429 keeps the entry, waits retry_after_ms without re-sending, then delivers once', async () => {
  let clock = 0; let calls = 0; let limited = true;
  const delivered: string[] = [];
  const outbox = new OutboxDelivery({
    now: () => clock, log: () => {}, save: async () => {},
    deliver: async (_to, text) => {
      calls++;
      if (limited) { limited = false; throw new Error('HTTP 429 {"errcode":"M_LIMIT_EXCEEDED","retry_after_ms":3000}'); }
      delivered.push(text);
    },
  });
  const to = { channel: 'mem', target: 'room' };
  const q: OutboxEntry[] = [outbox.create('s', to, 'a'), outbox.create('s', to, 'b')];
  assert.equal(await outbox.flush('s', q), false); assert.equal(calls, 1); assert.equal(q.length, 2);
  clock = 1000; assert.equal(await outbox.flush('s', q), false); assert.equal(calls, 1, 'no attempt before backoff elapsed');
  clock = 4000; assert.equal(await outbox.flush('s', q), true);
  assert.deepEqual(delivered, ['a', 'b']); assert.equal(q.length, 0);
  assert.equal(calls, 3, 'each message delivered exactly once after the single rate-limited try');
});

test('permanent failures are still parked, not backed off', async () => {
  const parked: string[] = [];
  const outbox = new OutboxDelivery({ now: () => 0, log: () => {}, save: async () => {},
    park: async e => { parked.push(e.text); },
    deliver: async () => { throw new PermanentDeliveryError('HTTP 403'); } });
  const q: OutboxEntry[] = [outbox.create('s', { channel: 'mem', target: 'r' }, 'x')];
  assert.equal(await outbox.flush('s', q), true); assert.deepEqual(parked, ['x']);
});
