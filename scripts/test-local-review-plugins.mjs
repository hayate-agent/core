// Explicit development integration; never changes plugins.lock.json or publishes pins.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw Error('Usage: node scripts/test-local-review-plugins.mjs <plugin-source> [test-files...]');
const source = path.resolve(process.argv[2]);
const directory = await mkdtemp(path.join(os.tmpdir(), 'local-review-lock-'));
try {
  const lock = JSON.parse(await readFile(path.join(root, 'plugins.lock.json'), 'utf8'));
  lock.files['review-executor.ts'] = '';
  for (const name of Object.keys(lock.files)) lock.files[name] = createHash('sha256').update(await readFile(path.join(source, 'src', name))).digest('hex');
  const localLock = path.join(directory, 'plugins.lock.json');
  await writeFile(localLock, JSON.stringify(lock));
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Development command failed (${result.status}): ${args[0]}`);
  };
  run(['scripts/materialize-plugins.mjs', source, localLock]);
  run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit']);
  const tests = process.argv.slice(3);
  run(['--import', 'tsx', '--test', ...(tests.length ? tests : ['test/dedicated-review-integration.test.ts', 'test/dedicated-review-routing.test.ts', 'test/review-workers.test.ts', 'test/review-worktree.test.ts', 'test/capability-context.test.ts'])]);
} finally { await rm(directory, { recursive: true, force: true }); }
