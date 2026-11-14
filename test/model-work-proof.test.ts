import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModelWorkProof } from '../src/model-work-proof.js';

test('private scheduling key signs request-bound proof; key remains immutable until owner recreation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-work-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const file = path.join(root, 'key.pem');
  await writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const proof = await ModelWorkProof.load(file); assert.ok(proof);
  const headers: Record<string, string | null> = { Authorization: 'unchanged', 'X-Hayate-Model-Work': 'interactive' };
  const add = (signer: ModelWorkProof) => signer.add(headers, 'POST', '/v1/chat/completions', 'a'.repeat(64), 'qwen3.8-flash-next');
  add(proof);
  const id = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  assert.equal(headers['X-Hayate-Qos-Key'], id); assert.equal(headers.Authorization, 'unchanged');
  assert.ok(Number(headers['X-Hayate-Qos-Expires']) > Date.now());
  assert.ok(Number(headers['X-Hayate-Qos-Expires']) <= Date.now() + 30000);
  const message = `hayate-model-work-v2\ninteractive\n${id}\n${headers['X-Hayate-Qos-Nonce']}\n${headers['X-Hayate-Qos-Expires']}\nPOST\n/v1/chat/completions\n${'a'.repeat(64)}\nqwen3.8-flash-next`;
  assert.ok(verify(null, Buffer.from(message), publicKey, Buffer.from(headers['X-Hayate-Qos-Signature']!, 'base64url')));
  assert.ok(!verify(null, Buffer.from(message.replace('/v1/chat/completions', '/v1/responses')), publicKey, Buffer.from(headers['X-Hayate-Qos-Signature']!, 'base64url')));
  const previous = headers['X-Hayate-Qos-Nonce']; add(proof); assert.notEqual(headers['X-Hayate-Qos-Nonce'], previous);
  const replacement = generateKeyPairSync('ed25519');
  await writeFile(file, replacement.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  add(proof); assert.equal(headers['X-Hayate-Qos-Key'], id);
  const reloaded = await ModelWorkProof.load(file); assert.ok(reloaded); add(reloaded); assert.notEqual(headers['X-Hayate-Qos-Key'], id);
  await symlink(file, path.join(root, 'link')); assert.equal(await ModelWorkProof.load(path.join(root, 'link')), undefined);
  for (const mode of [0o644, 0o700, 0o1600, 0o2600, 0o4600]) {
    await chmod(file, mode); assert.equal(await ModelWorkProof.load(file), undefined);
  }
  assert.equal(await ModelWorkProof.load(undefined), undefined); assert.equal(await ModelWorkProof.load(root), undefined);
});
