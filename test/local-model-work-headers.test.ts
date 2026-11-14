import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelWorkProof } from '../src/model-work-proof.js';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelWorkFetch } from '../src/model-work-fetch.js';

test('each HTTP retry is freshly bound; SDK one-token warming and unsupported paths cannot claim foreground', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-work-fetch-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('ed25519'); const file = path.join(root, 'key.pem');
  await writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const proof = ModelWorkProof.load(file); const seen: Headers[] = [];
  const base: typeof fetch = async (_input, init) => { seen.push(new Headers(init?.headers)); return new Response('{}'); };
  const transport = modelWorkFetch(base, proof, 'matrix:human', false);
  const body = JSON.stringify({ model: 'qwen3.8-flash-next', messages: [], max_tokens: 12 });
  for (let i=0;i<2;i++) await transport('http://offline.invalid/v1/chat/completions', { method: 'POST', body });
  assert.ok(seen[0].get('X-Hayate-Qos-Signature'));
  assert.notEqual(seen[0].get('X-Hayate-Qos-Nonce'), seen[1].get('X-Hayate-Qos-Nonce'));
  for (const field of ['max_tokens','max_completion_tokens','max_output_tokens']) {
    await transport('http://offline.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({model:'qwen3.8-flash-next', [field]:1}) });
    assert.equal(seen.at(-1)!.get('X-Hayate-Model-Work'), 'background'); assert.equal(seen.at(-1)!.get('X-Hayate-Qos-Signature'), null);
  }
  await transport('http://offline.invalid/openai/v1/chat/completions', { method: 'POST', body });
  assert.equal(seen.at(-1)!.get('X-Hayate-Qos-Signature'), null, 'unsupported prefixes stay unsigned');
});

test('final transport classification preserves credentials, options and custom fetch; never trusts stale proofs', async () => {
  const signal = new AbortController().signal;
  const body = '{"model":"qwen3.8-flash-next","messages":[]}';
  for (const [session, background, requested, expected] of [
    ['matrix:human', false, undefined, 'interactive'],
    ['dispatch:worker:claim', false, 'interactive', 'background'],
    ['matrix:human', true, 'interactive', 'background'],
    ['api:machine', false, undefined, 'background'],
    ['api:human', false, 'interactive', 'interactive'],
  ] as const) {
    let called = false;
    const base: typeof fetch = async (input, init) => {
      called = true; assert.equal(input, 'http://offline.invalid/v1/chat/completions');
      assert.equal(init?.signal, signal); assert.equal(init?.body, body);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Authorization'), 'Bearer offline-fixture');
      assert.equal(headers.get('X-Hayate-Model-Work'), expected);
      assert.equal(headers.get('X-Hayate-Qos-Signature'), null);
      return new Response('{}');
    };
    await modelWorkFetch(base, Promise.resolve(undefined), session, background, requested)(
      'http://offline.invalid/v1/chat/completions', { method: 'POST', body, signal,
        headers: { Authorization: 'Bearer offline-fixture', 'X-Hayate-Qos-Signature': 'stale' } });
    assert.ok(called);
  }
});
