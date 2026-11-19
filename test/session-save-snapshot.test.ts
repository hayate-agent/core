import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FilesystemSessionProvider} from '../src/sessions.js';

test('queued saves capture independent nested snapshots and retain revision conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'save-snapshot-'));
  try {
    const store = new FilesystemSessionProvider(root);
    const record = await store.create('c', 'test', []);
    record.title = 'first'; record.entries = [{text: 'first'}];
    const first = store.save(record, 0);
    record.title = 'second'; (record.entries[0] as {text:string}).text = 'second';
    const second = store.save(record, 1);
    record.title = 'third'; (record.entries[0] as {text:string}).text = 'third';
    const savedFirst = await first;
    assert.equal(savedFirst.title, 'first');
    assert.deepEqual(savedFirst.entries, [{text:'first'}]);
    const savedSecond = await second;
    assert.equal(savedSecond.title, 'second');
    assert.deepEqual(savedSecond.entries, [{text:'second'}]);
    assert.equal(savedSecond.revision, 2);
    assert.deepEqual(await store.load(record.id), savedSecond);
    assert.notEqual(savedSecond.entries, record.entries);
    await assert.rejects(store.save(record, 0), /revision conflict/);
    const recovered = await store.save(savedSecond, 2);
    assert.equal(recovered.revision, 3);
  } finally { await rm(root, {recursive:true,force:true}); }
});
