import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiRuntime } from '../src/runtime/pi.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

test('SDK headers require active foreground turn; maintenance/children/background cannot gain its proof', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'model-work-headers-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const models = await ModelRuntime.create();
  models.registerProvider('local-work', {
    api: 'openai-completions', baseUrl: 'https://offline.invalid', apiKey: 'offline',
    models: ['local', 'frontier'].map(id => ({ id, name: id, api: 'openai-completions', reasoning: false,
      input: ['text'], contextWindow: 131072, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  });
  const keyFile = path.join(home, 'model-work-key.pem');
  const { privateKey } = generateKeyPairSync('ed25519');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const runtime = new PiRuntime({ modelWorkKeyFile: keyFile, cwd: home, sessionsDir: path.join(home, 'sessions'),
    model: 'local-work/local', skillPaths: [], personaSections: async () => [],
    contextBudgets: () => ({ localModels: ['local-work/local'] }), approvals: { mode: 'off', tools: [] } });
  (runtime as any).modelRuntime = async () => models;
  for (const key of ['matrix:fixture', 'dispatch:fixture:claim', 'api:machine']) {
    const wrapped: any = await runtime.open(key), s = wrapped.session;
    try {
      const headers = () => s.extensionRunner.emitBeforeProviderHeaders({ Authorization: 'untouched' });
      assert.equal((await headers())['X-Hayate-Model-Work'], 'background', 'no active prompt, no foreground privilege');
      s.prompt = async () => {
        const foreground = !key.startsWith('dispatch:');
        assert.equal((await headers())['X-Hayate-Model-Work'], foreground ? 'interactive' : 'background');
        assert.equal(typeof (await headers())['X-Hayate-Qos-Signature'], foreground ? 'string' : 'undefined');
        assert.equal((await headers()).Authorization, 'untouched');
        await s.extensionRunner.emit({ type: 'session_before_compact', reason: 'threshold', preparation: {},
          branchEntries: [], signal: new AbortController().signal, willRetry: false });
        assert.equal((await headers())['X-Hayate-Model-Work'], 'background');
        await s.extensionRunner.emit({ type: 'session_compact_failed', reason: 'threshold', aborted: true, willRetry: false, fromExtension: false });
        assert.equal((await headers())['X-Hayate-Model-Work'], foreground ? 'interactive' : 'background');
        await s.extensionRunner.emit({ type: 'session_before_tree', preparation: { userWantsSummary: true }, signal: new AbortController().signal });
        assert.equal((await headers())['X-Hayate-Model-Work'], 'background');
        await s.extensionRunner.emit({ type: 'session_tree', newLeafId: null, oldLeafId: null });
      };
      s.waitForIdle = async () => {};
      await wrapped.prompt('metadata fixture', { modelWork: 'interactive' });
      assert.equal((await headers())['X-Hayate-Model-Work'], 'background', 'turn hint is cleared at settlement');
      await wrapped.setModel('local-work/frontier');
      assert.deepEqual(await headers(), { Authorization: 'untouched' });
    } finally { await wrapped.dispose(); }
  }
});
