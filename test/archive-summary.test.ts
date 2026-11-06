// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionArchives } from '../src/session-archive.js';

test('long summary pages remain JSON and expose the retrospective tail', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'summary-probe-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new SessionArchives(home);
  const retrospective = 'x'.repeat(30000) + 'TAIL_DECISION';
  const archive = await store.create('chat', 'source', retrospective, 'Next step', []);
  const first = JSON.parse(await store.read('chat', archive.id, { section: 'summary' }));
  assert.equal(first.retrospectiveTotalChars, retrospective.length);
  assert.equal(first.retrospectiveTruncated, true);
  const tail = JSON.parse(await store.read('chat', archive.id, { section: 'summary', charOffset: 30000 }));
  assert.equal(tail.retrospective, 'TAIL_DECISION');
  assert.equal(tail.retrospectiveTruncated, false);
});

test('summary bounds and short content remain predictable', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'summary-bounds-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new SessionArchives(home);
  const archive = await store.create('chat', 'source', 'short', 'next', []);
  await assert.rejects(store.read('chat', archive.id, { section: 'summary', charOffset: -1 }), /Invalid archive read bounds/);
  const short = JSON.parse(await store.read('chat', archive.id, { section: 'summary' }));
  assert.equal(short.retrospective, 'short');
  assert.equal(short.forward, 'next');
  assert.equal(short.retrospectiveTruncated, false);
  const beyond = JSON.parse(await store.read('chat', archive.id, { section: 'summary', charOffset: 100 }));
  assert.equal(beyond.retrospective, '');
  assert.equal(beyond.forward, '');
});
