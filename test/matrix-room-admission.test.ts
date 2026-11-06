// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MatrixChannel, matrixOptionsFromEnv } from '../src/builtin-plugins/matrix-channel.js';

const own = '!own:example.org', foreign = '!foreign:example.org', owner = '@owner:example.org';
function setup(admission: string | undefined) {
  const calls: string[] = [], delivered: unknown[] = [];
  const env: NodeJS.ProcessEnv = { MATRIX_HOMESERVER: 'https://example.org', MATRIX_ACCESS_TOKEN: 'test', MATRIX_ALLOWED_USERS: owner, MATRIX_E2EE: 'false' };
  if (admission !== undefined) env.MATRIX_ADMISSION_ROOMS = admission;
  const ch = new MatrixChannel({ ...matrixOptionsFromEnv(env, '/unused')!, fetch: (async (url: string) => { calls.push(url); return new Response('{}'); }) as typeof fetch });
  (ch as any).userId = '@bot:example.org';
  (ch as any).deliver = async (input: unknown) => { delivered.push(input); };
  return { ch, calls, delivered };
}
function invite() { return { invite_state: { events: [{ type: 'm.room.member', state_key: '@bot:example.org', sender: owner }] } }; }

test('explicit admission restricts invites even from an allowed owner', async () => {
  const { ch, calls } = setup(own);
  await (ch as any).onInvite(foreign, invite());
  assert.equal(calls.length, 0);
  await (ch as any).onInvite(own, invite());
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(encodeURIComponent(own)));
});
test('admission denies existing foreign DMs, encrypted inputs and approval reactions before handling', async () => {
  const { ch, calls, delivered } = setup(own);
  for (const type of ['m.room.message', 'm.room.encrypted', 'm.reaction']) {
    await (ch as any).onEvent(foreign, { type, sender: owner, event_id: '$event', content: { msgtype: 'm.text', body: '/approve x' } });
  }
  assert.equal(calls.length, 0);
  assert.equal(delivered.length, 0);
  assert.equal((ch as any).pendingEncrypted.size, 0);
});
test('admission blocks outbound text, edits, typing and room APIs with zero network side effects', async () => {
  const { ch, calls } = setup(own);
  await assert.rejects(ch.send({ channel: 'matrix', target: foreign }, 'no'), /room.*admission/i);
  await assert.rejects(ch.send({ channel: 'matrix', target: foreign }, 'no', { progressId: 'edit' }), /room.*admission/i);
  await assert.rejects(ch.typing({ channel: 'matrix', target: foreign }, false), /room.*admission/i);
  await assert.rejects((ch as any).api('PUT', `/rooms/${encodeURIComponent(foreign)}/send/m.reaction/x`, {}), /room.*admission/i);
  assert.equal(calls.length, 0);
});
test('explicit empty admission fails closed, absent setting preserves existing behavior', async () => {
  const closed = setup('');
  await (closed.ch as any).onInvite(own, invite());
  assert.equal(closed.calls.length, 0);
  await assert.rejects(closed.ch.send({ channel: 'matrix', target: own }, 'no'), /room.*admission/i);
  const legacy = setup(undefined);
  await (legacy.ch as any).onInvite(own, invite());
  assert.equal(legacy.calls.length, 1);
});
test('malformed explicit room admission is refused during configuration', () => {
  assert.throws(() => setup('not-a-room'), /admission/i);
});
test('crypto sync receives only admitted room timelines while device/key data is preserved', () => {
  const { ch } = setup(own);
  const response = { rooms: { join: { [own]: { timeline: { events: [] } }, [foreign]: { timeline: { events: [] } } } }, to_device: { events: [] }, device_one_time_keys_count: { signed_curve25519: 5 } };
  const admitted = (ch as any).admittedSync(response);
  assert.deepEqual(Object.keys(admitted.rooms.join), [own]);
  assert.equal(admitted.to_device, response.to_device);
  assert.equal(admitted.device_one_time_keys_count, response.device_one_time_keys_count);
  assert.equal(Object.keys(response.rooms.join).length, 2, 'original response is not mutated');
});
