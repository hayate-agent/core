import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, chmod, stat, writeFile, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskBookStorage } from '../src/task-book-storage.js';
import { ExecutionStore } from '../src/execution.js';
import { PartitionedJson } from '../src/partitioned-json.js';

test('task-book pages survive fsGroup remount read-only and missing committed pages never become an empty execution ledger', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-book-fsgroup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'executions.json'); const book = { tasks: [], bindings: [] };
  const storage = new TaskBookStorage(file); const ref = await storage.stage(book);
  const page = path.join(file + '.task-book', ref.root + '.json'); const bytes = await readFile(page);
  await chmod(page, 0o660); await chmod(file + '.task-book', 0o2770);
  assert.deepEqual(await new TaskBookStorage(file).hydrate(ref), book);
  assert.equal((await stat(page)).mode & 0o7777, 0o660); assert.equal((await stat(file + '.task-book')).mode & 0o7777, 0o2770);
  await new TaskBookStorage(file).stage(book); assert.equal((await stat(page)).mode & 0o7777, 0o600); assert.deepEqual(await readFile(page), bytes);
  await new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 }).save({ version: 2, executions: [], events: [], taskBookRef: ref });
  await rm(page);
  await assert.rejects(new ExecutionStore(file).load(), /Cannot load retained task book pages/);
  assert.deepEqual(await readFile(file).then(raw => JSON.parse(raw.toString()).document.taskBookRef), ref);
  await rm(file + '.task-book', { recursive: true });
  await assert.rejects(new TaskBookStorage(file).hydrate(ref), /Cannot load retained task book pages/);
  await assert.rejects(stat(file + '.task-book'), { code: 'ENOENT' });
});

for (const mode of [0o640, 0o660]) test(`partition hydration tolerates fsGroup ${mode.toString(8)} without modifying authority and durable writer reseals`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'partition-fsgroup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'executions.json');
  const document = { version: 2, executions: [{ id: 'completed', status: 'completed', parent: 'matrix:original', pendingIntent: { uncertain: true } }], events: [], turns: [] };
  await new PartitionedJson(file, { executions: 1, events: 100, turns: 100 }).save(document);
  const before = await readFile(file); const index = JSON.parse(before.toString());
  const payload = path.join(file + '.parts', index.collections.executions[0].hash + '.json'); const bytes = await readFile(payload);
  await chmod(payload, mode); await chmod(file, mode); await chmod(file + '.parts', 0o2770);
  const cold = new PartitionedJson(file, { executions: 1, events: 100, turns: 100 });
  assert.deepEqual(await cold.load(), document); assert.equal((await stat(file)).mode & 0o7777, mode, 'index load is also read-only'); assert.equal((await stat(payload)).mode & 0o7777, mode, 'qualification/load never changes filesystem metadata');
  assert.deepEqual(await readFile(file), before); assert.deepEqual(await readFile(payload), bytes);
  await cold.save(document, true);
  assert.equal((await stat(payload)).mode & 0o7777, 0o600); assert.deepEqual(await readFile(payload), bytes); assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await new PartitionedJson(file, { executions: 1, events: 100, turns: 100 }).load(), document);
});

test('fsGroup may be an authorized supplementary group, never an unrelated group', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'partition-group-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'executions.json'); const document = { executions: [{ id: 'same authority' }] };
  await new PartitionedJson(file, { executions: 1 }).save(document);
  const payload = path.join(file + '.parts', (await readdir(file + '.parts'))[0]); const actualGid = (await stat(payload)).gid;
  await chmod(payload, 0o660);
  // Model the kernel's group membership readback without changing host groups.
  const originalGid = process.getgid, originalGroups = process.getgroups;
  try {
    process.getgid = () => actualGid + 10000; process.getgroups = () => [actualGid];
    assert.deepEqual(await new PartitionedJson(file, { executions: 1 }).load(), document);
    process.getgroups = () => [actualGid + 10001];
    await assert.rejects(new PartitionedJson(file, { executions: 1 }).load(), /Missing\/unreadable partition/);
    assert.equal((await stat(payload)).mode & 0o7777, 0o660);
  } finally { process.getgid = originalGid; process.getgroups = originalGroups; }
});

for (const mode of [0o604, 0o664, 0o700, 0o760, 0o1600, 0o2600, 0o4600]) test(`partition hydration rejects unsafe mode ${mode.toString(8)}`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'partition-unsafe-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'executions.json'); await new PartitionedJson(file, { executions: 1 }).save({ executions: [{ id: 'untouched' }] });
  const payload = path.join(file + '.parts', (await readdir(file + '.parts'))[0]); await chmod(payload, mode);
  const before = await readFile(payload); await assert.rejects(new PartitionedJson(file, { executions: 1 }).load(), /Missing\/unreadable partition/);
  assert.deepEqual(await readFile(payload), before); assert.equal((await stat(payload)).mode & 0o7777, mode);
});

test('fsGroup acceptance never weakens checksum/symlink rejection or empty-store protection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'partition-closed-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'executions.json'); await new PartitionedJson(file, { executions: 1 }).save({ executions: [{ id: 'original' }] });
  const payload = path.join(file + '.parts', (await readdir(file + '.parts'))[0]); const bytes = await readFile(payload);
  await writeFile(payload, '{"different":"authority"}\n'); await chmod(payload, 0o660);
  await assert.rejects(new PartitionedJson(file, { executions: 1 }).load(), /checksum mismatch/);
  await rm(payload); const target = path.join(root, 'target'); await writeFile(target, bytes, { mode: 0o600 }); await symlink(target, payload);
  await assert.rejects(new PartitionedJson(file, { executions: 1 }).load(), /Missing\/unreadable partition/); assert.deepEqual(await readFile(target), bytes);
});
