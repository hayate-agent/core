import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileMemoryStore } from '../src/memory-worker.js';
import { memoryConfig } from '../src/memory.js';

for (const action of ['forget', 'revise'] as const) test(`queued embedding revalidates after ${action}`, { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embedding-revalidate-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const first = new Promise<void>((resolve) => { entered = resolve; });
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body).input);
    if (requests.length === 1) { entered(); await gate; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let store: FileMemoryStore | undefined;
  t.after(async () => {
    release(); await store?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = { sessionKey: 'test' };
  const seed = new FileMemoryStore(dir, memoryConfig());
  await seed.start();
  const entries = [];
  for (const key of ['A', 'B']) entries.push(await seed.put(ctx, { key, title: key, text: `OLD_${key}`, source: 'test', kind: 'note' }));
  await seed.close();
  store = new FileMemoryStore(dir, memoryConfig({ scanSeconds: 60, embedding: { url: `http://127.0.0.1:${address.port}`, model: 'test', dimensions: 3 } }));
  await store.start();
  await first;
  const next = entries.find((entry) => !requests[0].includes(entry.text))!;
  if (action === 'forget') await store.forget(ctx, next.id, next.revision);
  else await store.revise(ctx, next.id, next.revision, { text: 'NEW_CONTENT' });
  release();
  // Wait for eager batch and its immediate continuation to finish, not arbitrary network timing.
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (!(store as any).embeddingBusy) break;
  }
  assert.equal((store as any).embeddingBusy, false);
  assert.equal(requests.some((text) => text.includes(next.text)), false, 'superseded text must not be newly disclosed');
  if (action === 'revise') assert.ok(requests.some((text) => text.includes('NEW_CONTENT')), 'current revision remains eligible');
});
