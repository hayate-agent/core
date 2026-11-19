import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { modelWorkRequestDigest as digest } from '../src/model-work-request.js';

test('shared Node/Python golden fixture has identical identity and a valid final-transport signature', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/model-work-v2.json', import.meta.url), 'utf8'));
  const h = fixture.headers;
  assert.equal(digest(fixture.body), h['x-hayate-qos-request']);
  const message = `hayate-model-work-v2\ninteractive\n${h['x-hayate-qos-key']}\n${h['x-hayate-qos-nonce']}\n${h['x-hayate-qos-expires']}\nPOST\n/v1/chat/completions\n${h['x-hayate-qos-request']}\n${h['x-hayate-qos-model']}`;
  assert.ok(verify(null, Buffer.from(message), createPublicKey(fixture.publicKey), Buffer.from(h['x-hayate-qos-signature'], 'base64url')));
});

test('wire identity tolerates JSON formatting/model alias rewriting, not goals, sampling or nested model changes', () => {
  const first = '{"model":"public-alias","messages":[{"content":"Grüße 🐈","role":"user"}],"temperature":0.7,"n":-0}';
  const other = '{ "n":0.0, "messages":[{"role":"user","content":"Grüße 🐈"}],"temperature":7e-1,"model":"upstream-alias"}';
  assert.equal(digest(first), digest(other));
  assert.notEqual(digest(first), digest(first.replace('Grüße', 'different task')));
  assert.notEqual(digest(first), digest(first.replace('0.7', '0.8')));
  assert.notEqual(digest('{"model":"x","messages":[{"model":"first"}]}'), digest('{"model":"x","messages":[{"model":"other"}]}'));
  for (const body of ['[]','null','{"x":1e400}','{"x":9007199254740992}','{"x":"\\ud800"}', '['.repeat(66)+'0'+']'.repeat(66)]) assert.throws(() => digest(body));
});
