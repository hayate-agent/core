import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterMs, OutboxDelivery } from '../src/delivery/outbox.js';

for (const [token, expected] of [
  ['0', 0], ['1234', 1234], ['3600001', 3600000],
  ['1000000000', 3600000], ['999999999999999999999999999999', 3600000],
  ['1.5', undefined], ['1e6', undefined], ['1E+6', undefined],
  ['-1', undefined], ['12suffix', undefined], ['01', undefined],
  ['"123"', undefined], ['null', undefined],
] as const) {
  test(`complete retry token ${token}`, () => {
    assert.equal(retryAfterMs(new Error(`HTTP 429: {"retry_after_ms":${token},"errcode":"M_LIMIT_EXCEEDED"}`)), expected);
  });
}
test('long integer backoff prevents an early outbox retry', async () => {
  let now = 1000, calls = 0;
  const delivery = new OutboxDelivery({ now: () => now,
    deliver: async () => { if (++calls === 1) throw Error('{"retry_after_ms":1000000000}'); },
    save: async () => {}, log: () => {},
  });
  const queue = [delivery.create('s', { channel: 'matrix', target: 'synthetic' }, 'test')];
  assert.equal(await delivery.flush('s', queue), false);
  now += 1000;
  assert.equal(await delivery.flush('s', queue), false);
  assert.equal(calls, 1);
  now = 1000 + 3600000 + 250;
  assert.equal(await delivery.flush('s', queue), true);
  assert.equal(calls, 2);
  assert.equal(queue.length, 0);
});
