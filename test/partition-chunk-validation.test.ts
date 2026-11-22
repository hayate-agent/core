import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PartitionedJson } from '../src/partitioned-json.js';

for (const chunk of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects invalid partition chunk ${chunk} without starting a save`, () => {
    assert.throws(() => new PartitionedJson('/unused', { rows: chunk }), /Invalid partition chunk size for rows/);
  });
}
for (const chunk of [1, 2, Number.MAX_SAFE_INTEGER]) {
  test(`valid partition chunk ${chunk} preserves order and remainder`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'partition-chunk-'));
    try {
      const file = path.join(dir, 'state.json');
      const document = { version: 2, rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
      await new PartitionedJson(file, { rows: chunk }).save(document);
      assert.deepEqual(await new PartitionedJson(file, { rows: chunk }).load(), document);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
