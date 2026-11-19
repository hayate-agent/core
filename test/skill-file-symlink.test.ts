import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverSkills } from '../src/skills.js';

test('file-linked SKILL.md is discovered while broken and directory targets are excluded', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'skill-file-link-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'root');
  await mkdir(root);
  const text = (name: string) => `---\nname: ${name}\ndescription: Test fixture\n---\nBody\n`;
  const target = path.join(tmp, 'source.md');
  await writeFile(target, text('linked'));
  for (const name of ['linked', 'ordinary', 'broken', 'directory', 'other']) await mkdir(path.join(root, name));
  await symlink(target, path.join(root, 'linked', 'SKILL.md'));
  await writeFile(path.join(root, 'ordinary', 'SKILL.md'), text('ordinary'));
  await symlink(path.join(tmp, 'missing'), path.join(root, 'broken', 'SKILL.md'));
  await mkdir(path.join(root, 'directory', 'SKILL.md'));
  await symlink(target, path.join(root, 'other', 'NOT-SKILL.md'));
  const skills = await discoverSkills([root]);
  assert.deepEqual(skills.map(s => s.name), ['linked', 'ordinary']);
  assert.equal(skills[0].filePath, path.join(root, 'linked', 'SKILL.md'));
  assert.equal(skills[0].baseDir, path.join(root, 'linked'));
});
