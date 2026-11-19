import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, stat, rename, symlink, utimes, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskBookStorage } from '../src/task-book-storage.js';
import { enrollTask, type TaskBook } from '../src/task-lifecycle.js';

type Readable = { read(hash: string, durable?: boolean): Promise<{ raw: string; identity?: string }> };
function reads(storage: TaskBookStorage) {
  const io = storage as unknown as Readable, read = io.read.bind(storage);
  const calls: Array<{ hash: string; durable: boolean }> = [];
  io.read = async (hash, durable = false) => { calls.push({ hash, durable }); return read(hash, durable); };
  return calls;
}
async function fixture(t: test.TestContext, count = 129) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-book-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'executions.json'), storage = new TaskBookStorage(file);
  const book: TaskBook = { tasks: [], bindings: [] };
  for (let i = 0; i < count; i++) enrollTask(book, { sessionKey: 'matrix:original', taskId: `input-${i}` },
    `Exact operator mandate ${i}: retain HOLD and uncertain effects`, `input-${i}`, 'operator', 1000 + i);
  const ref = await storage.stage(book);
  const manifest = JSON.parse(await readFile(path.join(file + '.task-book', ref.root + '.json'), 'utf8'));
  return { root, file, storage, book, ref, manifest, page: path.join(file + '.task-book', manifest.tasks[0] + '.json') };
}

test('same writer does not reread/fsync every unchanged task-book page; exact authority survives reload', async t => {
  const f = await fixture(t), calls = reads(f.storage);
  assert.deepEqual(await f.storage.stage(f.book), f.ref);
  assert.deepEqual(calls, [], 'unchanged pages use freshly checked identity, not full durable rereads');
  f.book.tasks[0]!.technical = { state: 'blocked', evidence: 'HOLD remains; effects unknown' };
  const changed = await f.storage.stage(f.book);
  assert.notEqual(changed.root, f.ref.root);
  assert.equal(calls.length, 2, 'only the changed task page and new root cross full-read barriers');
  assert.deepEqual(await new TaskBookStorage(f.file).hydrate(changed), f.book);
  assert.deepEqual(await new TaskBookStorage(f.file).hydrate(f.ref),
    { ...f.book, tasks: f.book.tasks.map((task, i) => i ? task : { ...task, technical: { state: 'unknown' } }) });
});

test('cold hydration is read-only and never substitutes for the new writer durability barrier', async t => {
  const f = await fixture(t), cold = new TaskBookStorage(f.file), calls = reads(cold);
  assert.deepEqual(await cold.hydrate(f.ref), f.book);
  assert.equal(calls.filter(c => c.durable).length, 0);
  calls.length = 0;
  assert.deepEqual(await cold.stage(f.book), f.ref);
  assert.equal(calls.filter(c => c.durable).length, 5, 'three task pages, one binding page and root re-established durably');
  calls.length = 0;
  assert.deepEqual(await cold.stage(f.book), f.ref);
  assert.deepEqual(calls, []);
});

test('fsGroup mode changes invalidate the same writer cache and reseal exact bytes', async t => {
  const f = await fixture(t), bytes = await readFile(f.page), calls = reads(f.storage);
  await chmod(f.page, 0o660);
  assert.deepEqual(await f.storage.stage(f.book), f.ref);
  assert.equal(calls.filter(c => c.durable).length, 1);
  assert.equal((await stat(f.page)).mode & 0o7777, 0o600);
  assert.deepEqual(await readFile(f.page), bytes);
  calls.length = 0;
  await f.storage.stage(f.book);
  assert.deepEqual(calls, []);
});

test('same-size corruption with restored mtime still invalidates cached checksum via ctime', async t => {
  const f = await fixture(t), before = await stat(f.page), bytes = await readFile(f.page, 'utf8');
  const changed = bytes.replace('Exact operator mandate', 'Other operator mandate');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(bytes));
  await writeFile(f.page, changed);
  await utimes(f.page, before.atime, before.mtime);
  await assert.rejects(f.storage.stage(f.book), /checksum mismatch/);
  await assert.rejects(f.storage.stage(f.book), /checksum mismatch/, 'failed validation cannot refresh the cached identity');
});

test('inode replacement with identical bytes crosses the original durable verification barrier', async t => {
  const f = await fixture(t), calls = reads(f.storage), bytes = await readFile(f.page);
  const replacement = path.join(f.root, 'replacement');
  await writeFile(replacement, bytes, { mode: 0o600 });
  await rename(replacement, f.page);
  assert.deepEqual(await f.storage.stage(f.book), f.ref);
  assert.equal(calls.filter(c => c.durable).length, 1);
});

test('cached pages still reject symlink replacement and missing committed files without recreating them', async t => {
  const f = await fixture(t), bytes = await readFile(f.page), target = path.join(f.root, 'target');
  await writeFile(target, bytes, { mode: 0o600 });
  await rm(f.page); await symlink(target, f.page);
  await assert.rejects(f.storage.stage(f.book), /Unsafe task book page/);
  assert.deepEqual(await readFile(target), bytes);
  await rm(f.page);
  await assert.rejects(f.storage.stage(f.book), { code: 'ENOENT' });
  await assert.rejects(stat(f.page), { code: 'ENOENT' });
});

for (const mode of [0o604, 0o700, 0o1600]) test(`cached pages still reject unsafe mode ${mode.toString(8)}`, async t => {
  const f = await fixture(t, 1); await chmod(f.page, mode);
  await assert.rejects(f.storage.stage(f.book), /Unsafe task book page/);
});

test('writer ownership and directory authority are checked even for fully cached pages', async t => {
  const f = await fixture(t, 1), uid = process.getuid;
  try {
    if (uid) {
      process.getuid = () => uid() + 10000;
      await assert.rejects(f.storage.stage(f.book), /Unsafe task book directory/);
    }
  } finally { process.getuid = uid; }
  await chmod(f.file + '.task-book', 0o500);
  await assert.rejects(f.storage.stage(f.book), /owner-read-only/);
  await chmod(f.file + '.task-book', 0o700);
});

test('failed durability completion is not cached and retry performs the original barrier again', async t => {
  const f = await fixture(t, 1), cold = new TaskBookStorage(f.file);
  const io = cold as unknown as Readable, read = io.read.bind(cold);
  let failed = false, durableReads = 0;
  io.read = async (hash, durable = false) => {
    if (durable) durableReads++;
    const raw = await read(hash, durable);
    if (durable && !failed) { failed = true; throw new Error('injected durability completion failure'); }
    return raw;
  };
  await assert.rejects(cold.stage(f.book), /injected durability/);
  assert.deepEqual(await cold.stage(f.book), f.ref);
  assert.equal(durableReads, 4, 'first page retried durably, then binding page and root');
  durableReads = 0;
  await cold.stage(f.book);
  assert.equal(durableReads, 0);
});

for (const kind of ['existing', 'new']) for (const mutation of ['replace', 'modify'])
test(`${kind} page ${mutation} after durable verification cannot become a cached receipt`, async t => {
  const f = await fixture(t, 1);
  const file = kind === 'existing' ? f.file : path.join(f.root, 'new-ledger.json');
  const storage = new TaskBookStorage(file), io = storage as unknown as Readable;
  const read = io.read.bind(storage); let changed = false;
  io.read = async (hash, durable = false) => {
    const result = await read(hash, durable);
    if (durable && !changed) {
      changed = true;
      const page = path.join(file + '.task-book', hash + '.json');
      const bad = result.raw.replace('Exact operator mandate', 'Other operator mandate');
      if (mutation === 'replace') {
        const replacement = path.join(f.root, 'replacement');
        await writeFile(replacement, bad, { mode: 0o600 }); await rename(replacement, page);
      } else await writeFile(page, bad);
    }
    return result;
  };
  await assert.rejects(storage.stage(f.book), /changed before cache refresh/);
  assert.equal(changed, true);
  await assert.rejects(storage.stage(f.book), /checksum mismatch/,
    'retry must not trust the unverified replacement/modification');
});

test('modification during descriptor fsync cannot adopt a post-modification identity', async t => {
  const f = await fixture(t, 1), originalInfo = await stat(f.page);
  const handle = await open(f.page, 'r'), proto = Object.getPrototypeOf(handle);
  await handle.close();
  const sync = proto.sync; let changed = false;
  try {
    proto.sync = async function () {
      const info = await this.stat();
      if (!changed && info.dev === originalInfo.dev && info.ino === originalInfo.ino) {
        changed = true;
        const raw = await readFile(f.page, 'utf8');
        await writeFile(f.page, raw.replace('Exact operator mandate', 'Other operator mandate'));
      }
      return sync.call(this);
    };
    await assert.rejects(new TaskBookStorage(f.file).stage(f.book), /changed during verification/);
    assert.equal(changed, true);
  } finally { proto.sync = sync; }
});
