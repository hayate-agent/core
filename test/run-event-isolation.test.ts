import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunRegistry, type RunEvent } from '../src/api/runs.js';

function setup() {
  const registry = new RunRegistry('/unused-event-isolation.json', { now: () => 1000 });
  const run = registry.create({ session_key: 'test' });
  return { registry, id: run.run_id };
}
function usage(registry: RunRegistry, id: string) {
  registry.turnEvent(id, { type: 'usage', input: 10, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.01 });
}
for (const field of ['seq', 'data', 'nested'] as const) {
  test(`listener mutation of ${field} cannot change later listener or replay`, () => {
    const { registry, id } = setup();
    registry.subscribe(id, -1, event => {
      if (!event) return;
      if (field === 'seq') event.seq = 999;
      else if (field === 'data') event.data.event = 'corrupted';
      else (event.data.usage as Record<string, unknown>).input_tokens = 999;
    });
    const received: RunEvent[] = [];
    registry.subscribe(id, -1, event => { if (event) received.push(event); });
    usage(registry, id);
    assert.equal(received[0].seq, 0);
    assert.equal(received[0].data.event, 'usage.updated');
    assert.equal((received[0].data.usage as any).input_tokens, 10);
    const replay = registry.subscribe(id, -1, () => {}).replay;
    assert.deepEqual(replay, received);
    assert.equal(replay[0].seq, 0);
    assert.equal(replay[0].data.event, 'usage.updated');
    assert.equal((replay[0].data.usage as any).input_tokens, 10);
  });
  test(`replay mutation of ${field} cannot rewrite retained history`, () => {
    const { registry, id } = setup(); usage(registry, id);
    const first = registry.subscribe(id, -1, () => {}).replay;
    if (field === 'seq') first[0].seq = 999;
    else if (field === 'data') first[0].data.event = 'corrupted';
    else (first[0].data.usage as any).input_tokens = 999;
    const next = registry.subscribe(id, -1, () => {}).replay;
    assert.equal(next[0].seq, 0);
    assert.equal(next[0].data.event, 'usage.updated');
    assert.equal((next[0].data.usage as any).input_tokens, 10);
  });
}
test('unmodified subscribers preserve ordering, cursor filtering and usage totals', () => {
  const { registry, id } = setup(); registry.started(id); usage(registry, id); usage(registry, id);
  const subscription = registry.subscribe(id, 0, () => {});
  assert.deepEqual(subscription.replay.map(e => e.seq), [1, 2]);
  assert.equal((subscription.replay[1].data.usage as any).input_tokens, 20);
  assert.equal(subscription.closed, false);
  assert.equal(registry.get(id)?.usage?.input_tokens, 20);
});
