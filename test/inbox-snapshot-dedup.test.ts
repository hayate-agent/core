import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InboxLedger } from '../src/delivery/inbox.js';
import type { Inbound } from '../src/types.js';

test('snapshot evaluates replayability only once per accepted input identity', () => {
  let reads = 0;
  const input = { id: 'input', get source() { reads++; return 'channel'; } } as Inbound;
  const ledger = new InboxLedger();
  ledger.handoff.add(input);
  const duplicates = Array(1000).fill(input);
  assert.deepEqual(ledger.snapshot([{ current: input, steered: duplicates, queue: duplicates }]), [input]);
  assert.equal(reads, 2);
});

test('snapshot preserves identity order and replayability across duplicate references', () => {
  for (const source of ['host', 'channel', 'api', 'cron', 'heartbeat', 'loop', 'goal']) {
    for (const continuationDepth of [0, 1]) {
      const first = { id: 'first', source, continuationDepth } as Inbound;
      const second = { id: 'second', source: 'api' } as Inbound;
      const ledger = new InboxLedger();
      ledger.handoff.add(first);
      const expected = ['host', 'channel', 'api', 'cron'].includes(source) || continuationDepth > 0
        ? [first, second] : [second];
      assert.deepEqual(ledger.snapshot([{ current: first, steered: [second, first], queue: [first, second] }]), expected);
    }
  }
});
