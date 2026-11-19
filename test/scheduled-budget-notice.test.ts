import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness } from '../src/harness.js';
import { FakeRuntime, MemoryChannel } from './fakes.js';

const key = 'cron:example';
function setup() {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const channel = new MemoryChannel(); h.addChannel(channel);
  h.restoreSessions([{ key, replyTo: { channel: 'mem', target: 'room' }, tasks: [{
    id: 'task', original: 'PRIVATE mandate', next: 'PRIVATE next', state: 'blocked', depth: 20,
    termination: 'productive_budget_exhausted', explicitBlocked: false,
    repetition: { version: 1, repetitions: 20, attempts: 20, evidence: [] },
  }] }]);
  return { h, channel };
}

test('scheduled exhaustion retains task and marker without posting diagnostic', async () => {
  const { h, channel } = setup(); h.onStateChange = async () => {};
  try {
    await h.tick(); await h.drained();
    assert.equal(channel.sent.length, 0); assert.equal(h.outboxEntries().length, 0);
    const t = h.state(key).tasks![0]!;
    assert.ok(t.budgetAttentionId); assert.equal(t.state, 'blocked'); assert.equal(t.next, 'PRIVATE next');
  } finally { await h.stop(0); }
});

test('restored host notice removed only after durable migration; ordinary messages retained', async () => {
  const { h, channel } = setup(); const t = h.state(key).tasks![0]!;
  t.budgetAttentionId = `task-budget:${key}:task`;
  const base = { sessionKey: key, to: { channel: 'mem', target: 'room' } };
  h.restoreOutbox([{ ...base, id: t.budgetAttentionId, text: 'Aufgabe: PRIVATE\nAktionsbudget erschöpft: 20 Wiederholungen ohne neue Host-Evidenz verbraucht.' },
    { ...base, id: 'ordinary', text: 'Verified result' }]);
  let offline = true, saves = 0; h.onStateChange = async () => { saves++; if (offline) throw Error('offline'); };
  try {
    h.releaseRestored(); for (let i = 0; i < 100 && !saves; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(saves); assert.equal(channel.sent.length, 0);
    offline = false; await h.tick(); await h.drained();
    assert.deepEqual(channel.texts(), ['Verified result']); assert.equal(t.state, 'blocked'); assert.equal(t.next, 'PRIVATE next');
  } finally { await h.stop(0); }
});
