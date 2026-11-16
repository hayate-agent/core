import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git, captureChangeset } from '../src/changeset.js';

test('review evidence ignores Git presentation color configuration', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'changeset-color-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ['init']);
  await git(dir, ['config', 'user.name', 'Fixture']);
  await git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(dir, 'file.txt'), 'before\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'base']);
  await writeFile(path.join(dir, 'file.txt'), 'after\n');
  await git(dir, ['config', 'color.ui', 'false']);
  const plain = await captureChangeset(dir, 'HEAD');
  for (const setting of ['color.ui', 'color.diff']) {
    await git(dir, ['config', setting, 'always']);
    const colored = await captureChangeset(dir, 'HEAD');
    assert.equal(colored.diff, plain.diff, setting);
    assert.equal(colored.fingerprint, plain.fingerprint, setting);
    assert.ok(!colored.diff.includes('\x1b['), setting);
  }
  await writeFile(path.join(dir, 'file.txt'), 'different\n');
  assert.notEqual((await captureChangeset(dir, 'HEAD')).fingerprint, plain.fingerprint);
});
