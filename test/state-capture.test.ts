import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StateStore, type PersistedState } from '../src/state.js';

const state = (value: number) => ({ version: 1, paused: false, sessions: [], seen: [String(value)] }) as PersistedState;

test('queued host captures do not materialize snapshots until their serialized write slot; no barriers are dropped', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'state-capture-')); t.after(() => rm(dir, { recursive: true, force: true }));
 const store = new StateStore(path.join(dir, 'state.json')); const captured: number[] = [];
 const writes = Array.from({ length: 100 }, (_, i) => store.capture(() => { captured.push(i); return state(i); }));
 assert.deepEqual(captured, [], 'queued captures retain factories, not N serialized state graphs');
 await Promise.all(writes); assert.deepEqual(captured, Array.from({ length: 100 }, (_, i) => i));
 assert.deepEqual((await new StateStore(store.file).load())?.seen, ['99']);
});

test('capture failures do not hide failed barriers or poison later writes; ordinary save still snapshots immediately', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'state-capture-')); t.after(() => rm(dir, { recursive: true, force: true }));
 const store = new StateStore(path.join(dir, 'state.json'));
 await assert.rejects(store.capture(() => { throw Error('snapshot failed'); }), /snapshot failed/);
 const original = state(1); const saved = store.save(original); original.seen = ['mutated']; await saved;
 assert.deepEqual((await new StateStore(store.file).load())?.seen, ['1']);
 await store.capture(() => state(2)); assert.deepEqual((await store.load())?.seen, ['2']);
});
