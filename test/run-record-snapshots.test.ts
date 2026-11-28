import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunRegistry } from '../src/api/runs.js';

for (const lookup of ['id', 'key'] as const) {
  for (const field of ['status', 'usage', 'actual', 'identity'] as const) {
    test(`${lookup} lookup isolates ${field} mutations and persistence`, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'run-snapshot-'));
      try {
        const registry = new RunRegistry(path.join(dir, 'runs.json'));
        const run = registry.create({ session_key: 'test', idempotency_key: 'key', body_hash: 'hash' });
        registry.turnEvent(run.run_id, { type: 'usage', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.01, model: 'test/model', thinking: 'off' });
        const before = structuredClone(registry.get(run.run_id)!);
        const snapshot = (lookup === 'id' ? registry.get(run.run_id) : registry.byIdempotencyKey('key'))!;
        if (field === 'status') snapshot.status = 'completed';
        if (field === 'usage') snapshot.usage!.input_tokens = 999;
        if (field === 'actual') snapshot.actual!.model = 'changed/model';
        if (field === 'identity') { snapshot.run_id = 'changed'; snapshot.idempotency_key = 'changed'; }
        assert.deepEqual(registry.get(run.run_id), before);
        assert.deepEqual(registry.byIdempotencyKey('key'), before);
        await registry.save();
        const stored = JSON.parse(await readFile(path.join(dir, 'runs.json'), 'utf8'));
        assert.deepEqual(stored.runs[0], before);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
}
test('missing lookups remain undefined and retained snapshots stay stable', () => {
  const registry = new RunRegistry('/unused');
  assert.equal(registry.get('missing'), undefined);
  assert.equal(registry.byIdempotencyKey('missing'), undefined);
  const created = registry.create({ session_key: 'test' });
  const snapshot = registry.get(created.run_id)!;
  registry.started(created.run_id);
  assert.equal(snapshot.status, 'queued');
  assert.equal(registry.get(created.run_id)!.status, 'running');
});
