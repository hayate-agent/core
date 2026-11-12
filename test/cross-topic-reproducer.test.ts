// Offline only: source product, fake runtime/channel, temporary execution ledger.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness.js';
import { ExecutionStore } from '../src/execution.js';
import { parseHashtags } from '../src/hashtags.js';
import { semanticTopicLabeler } from '../src/topic-labels.js';
import { FakeRuntime, MemoryChannel, ROOM, msg } from './fakes.ts';

test('numeric issue references are not explicit hashtags; semantic wrong selection still passes schema', async () => {
  assert.deepEqual(parseHashtags('Appointment #59968 vs kernel #60612 and 60612'), []);
  const candidates = [
    { id: 'appointment', text: 'Appointment 59968', tags: ['appointments'] },
    { id: 'security', text: 'Kernel mitigation 60612', tags: ['security', 'kernel-mitigation'] },
  ];
  const labeler = semanticTopicLabeler({ review: async () => JSON.stringify({ topic: 'security', inherit: true, tags: ['incident-investigation'] }) }, () => undefined);
  // Deliberately incorrect meaning, syntactically valid. No real model called.
  assert.deepEqual(await labeler('Appointment 59968', candidates), ['security', 'kernel-mitigation', 'incident-investigation']);
});

for (const busyMode of ['queue', 'steer'] as const) test(`${busyMode}: host appointment A and operator security B remain separate`, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cross-topic-'));
  let h;
  try {
    const store = new ExecutionStore(path.join(home, 'executions.json')); await store.load();
    const execution = await store.submit('mem:room1', 'synthetic-request', 'Appointment 59968', 'direct', 1,
      { taskId: 'synthetic-appointment-task', original: 'Appointment 59968', depth: 0,
        anchor: { id: 'synthetic-appointment-message', task: 'Appointment 59968', receivedAt: 1, replyTo: { ...ROOM, thread: 'appointment-thread' }, outputTags: ['appointments'] } });
    const claim = await store.claim(execution.id); await store.complete(execution.id, claim.token, 'Appointment result');
    const runtime = new FakeRuntime(text => text.includes('Kernel mitigation') ? 'security reply' : 'appointment reply');
    const channel = new MemoryChannel();
    h = new Harness({ runtime, executionStore: store, hostEventAllowed: () => true, tickMs: 60000, busyMode });
    h.onStateChange = async () => {};
    h.addChannel(channel); await h.start();
    await h.sessionFor('mem:room1');
    const session = runtime.sessions.get('mem:room1'); const release = session.hold();
    try {
      await h.accept({ sessionKey: 'mem:room1', source: 'host', hostEvent: { executionId: execution.id }, text: 'Appointment result 59968', replyTo: ROOM });
      for (let i=0; i<100 && !session.busy; i++) await new Promise(r => setTimeout(r, 5));
      assert.equal(session.busy, true);
      const securityReply = { channel: 'mem', target: 'security-thread' };
      await h.accept({ ...msg('Kernel mitigation 60612 #security'), id: 'synthetic-security-message', replyTo: securityReply });
      assert.deepEqual(session.steered, []);
      assert.equal(h.sessions.get('mem:room1').queue.length, 1);
      assert.equal(h.sessions.get('mem:room1').current.source, 'host');
    } finally { release(); }
    await h.waitForSessionIdle('mem:room1');
    assert.equal(session.prompts.length, 2);
    assert.deepEqual(channel.sent[0].to, { ...ROOM, thread: 'appointment-thread' });
    assert.equal(channel.sent[0].text, '#appointments · appointment reply');
    const sent = channel.sent.at(-1);
    assert.equal(sent.to.target, 'security-thread');
    assert.equal(sent.text, '#security · security reply');
    console.log(JSON.stringify({ scenario: `busy host A + independent operator B, busyMode=${busyMode}`, prompts: session.prompts, steered: session.steered, delivered: sent }));
  } finally { await h?.stop(1000); await rm(home, { recursive: true, force: true }); }
});
