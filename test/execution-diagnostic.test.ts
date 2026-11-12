import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ExecutionStore } from '../src/execution.js';

test('failure without intent pauses; stale failures cannot affect replacement or manual control', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'execution-diagnostic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, 'ledger.json')); await store.load();
  const task = await store.submit('parent', 'request', 'fixture', 'direct');
  const first = await store.claim(task.id);
  await store.fail(task.id, first.token!, 'runtime-failure');
  assert.equal(store.list()[0].status, 'paused');
  assert.equal(store.list()[0].diagnosticCode, 'runtime-failure');
  await store.control(task.id, 'resume');
  assert.equal(store.list()[0].diagnosticCode, undefined);
  const second = await store.claim(task.id);
  await store.fail(task.id, first.token!, 'worker-failed');
  assert.equal(store.list()[0].status, 'running');
  assert.equal(store.list()[0].token, second.token);
  await store.control(task.id, 'pause');
  await store.fail(task.id, second.token!, 'worker-failed');
  assert.equal(store.list()[0].diagnosticCode, 'manual-pause');
});
