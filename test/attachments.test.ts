import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { loadAttachments } from '../src/attachments.js';
import { Harness } from '../src/harness.js';
import { StateStore } from '../src/state.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';
const sessionKey = 'mem:room1';
const directory = (root: string, key = sessionKey) => path.join(root, createHash('sha256').update(key).digest('hex'));
const png = Buffer.from([137,80,78,71,13,10,26,10]);
async function fixture(root: string) {
  const sha256 = createHash('sha256').update(png).digest('hex');
  await mkdir(directory(root)); await writeFile(path.join(directory(root), sha256), png);
  return { sessionKey, sha256, size: png.length, name: 'untrusted.png' };
}
test('persisted accepted inbox restores into actual model image inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'attachments-'));
  let restored: Harness | undefined;
  try {
    const ref = await fixture(root);
    const store = new StateStore(path.join(root, 'state.json'));
    const first = new Harness({ runtime: new FakeRuntime(), attachmentRoot: root });
    first.paused = true;
    first.onStateChange = () => store.save({ version: 1, paused: true, busyMode: 'queue', sessions: first.snapshotSessions(), pending: first.pendingInputs() });
    await first.accept({ ...msg('describe'), id: 'image-input', attachments: [ref] });
    const saved = await new StateStore(store.file).load();
    assert.equal(saved!.pending!.length, 1);
    assert.equal(JSON.stringify(saved).includes(png.toString('base64')), false);
    const runtime = new FakeRuntime();
    restored = new Harness({ runtime, attachmentRoot: root }); restored.addChannel(new MemoryChannel());
    restored.restoreSessions(saved!.sessions); restored.restorePending(saved!.pending!);
    await restored.start();
    restored.releaseRestored();
    for (let i = 0; i < 100 && !runtime.sessions.get(sessionKey)?.prompts.length; i++) await new Promise(r => setTimeout(r, 2));
    const session = runtime.sessions.get(sessionKey)!;
    assert.ok(session.prompts[0].includes('Untrusted inbound attachments'));
    assert.deepEqual(session.options[0].images, [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
  } finally { await restored?.stop(); await rm(root, { recursive: true, force: true }); }
});
test('cross-session, relabelled and API references are rejected before acceptance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'attachments-'));
  try {
    const ref = await fixture(root);
    const harness = new Harness({ runtime: new FakeRuntime(), attachmentRoot: root });
    const input = { ...msg('steal'), id: 'foreign', sessionKey: 'mem:other', attachments: [ref] };
    await assert.rejects(harness.accept(input), /Invalid/);
    await assert.rejects(harness.accept({ ...input, attachments: [{ ...ref, sessionKey: 'mem:other' }] }), /ENOENT/);
    await assert.rejects(harness.accept({ ...msg('api'), source: 'api', attachments: [ref] }), /channel ingress/);
    assert.deepEqual(harness.pendingInputs(), []);
    // A denied ID was never marked seen: a corrected owned reference is accepted.
    harness.paused = true; harness.onStateChange = async () => {};
    await harness.accept({ ...msg('owned'), id: 'foreign', attachments: [ref] });
    assert.equal(harness.pendingInputs().length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('submit and enqueue reject invalid sources and foreign ownership before queueing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'attachments-'));
  try {
    const ref = await fixture(root);
    const harness = new Harness({ runtime: new FakeRuntime(), attachmentRoot: root });
    harness.paused = true;
    for (const source of ['api', 'host', 'cron'] as const) {
      const input = { ...msg('denied'), source, attachments: [ref] };
      await assert.rejects(harness.submit(input), /channel ingress/);
      assert.throws(() => harness.enqueue(input), /channel ingress/);
    }
    const foreign = { ...msg('denied'), sessionKey: 'mem:other', attachments: [ref] };
    await assert.rejects(harness.submit(foreign), /Invalid/);
    assert.throws(() => harness.enqueue(foreign), /Invalid/);
    const relabelled = { ...foreign, attachments: [{ ...ref, sessionKey: 'mem:other' }] };
    await assert.rejects(harness.submit(relabelled), /ENOENT/);
    assert.deepEqual(harness.pendingInputs(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restored forged inputs cannot deliver any image or text to runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'attachments-'));
  try {
    const ref = await fixture(root);
    for (const patch of [
      { source: 'api' as const },
      { sessionKey: 'mem:other' },
      { sessionKey: 'mem:other', attachments: [{ ...ref, sessionKey: 'mem:other' }] },
    ]) {
      const runtime = new FakeRuntime();
      const harness = new Harness({ runtime, attachmentRoot: root });
      harness.addChannel(new MemoryChannel());
      harness.restorePending([{ ...msg('forged'), attachments: [ref], ...patch }]);
      await harness.start(); harness.releaseRestored();
      for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 2));
      assert.equal([...runtime.sessions.values()].reduce((n, session) => n + session.prompts.length, 0), 0);
      await harness.stop();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('FIFO attachment admission rejects promptly without a writer or a blocked worker thread', { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'attachments-fifo-'));
  try {
    const ref = await fixture(root);
    const file = path.join(directory(root), ref.sha256);
    await rm(file);
    await promisify(execFile)('mkfifo', [file]);
    // Use a killable child: removing O_NONBLOCK must fail this regression instead
    // of leaving a blocked libuv open in the test process indefinitely.
    const script = `
      const { Harness } = await import('./src/harness.ts');
      const { FakeRuntime, msg } = await import('./test/fakes.ts');
      const harness = new Harness({ runtime: new FakeRuntime(), attachmentRoot: process.argv[1] });
      const ref = JSON.parse(process.argv[2]);
      try {
        await harness.accept({ ...msg('FIFO'), attachments: [ref] });
        throw Error('FIFO was incorrectly accepted');
      } catch (error) {
        if (!String(error.message).includes('Attachment size mismatch')) throw error;
        if (harness.pendingInputs().length) throw Error('FIFO entered inbox');
      }
    `;
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, JSON.stringify(ref)], {
      cwd: process.cwd(), timeout: 3000, killSignal: 'SIGKILL',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tampered references, wrong bytes and symlinks fail closed at load/replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'attachments-'));
  try {
    const ref = await fixture(root);
    await writeFile(path.join(directory(root), ref.sha256), Buffer.alloc(png.length));
    await assert.rejects(loadAttachments(root, sessionKey, [ref]), /integrity/);
    await assert.rejects(loadAttachments(root, sessionKey, [{ ...ref, sha256: '../escape' }]), /Invalid/);
    await rm(path.join(directory(root), ref.sha256));
    await symlink('/etc/passwd', path.join(directory(root), ref.sha256));
    await assert.rejects(loadAttachments(root, sessionKey, [ref]));
  } finally { await rm(root, { recursive: true, force: true }); }
});
