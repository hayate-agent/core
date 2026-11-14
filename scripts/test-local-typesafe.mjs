// Explicit offline two-repository development harness. Production pins are NOT
// changed or bypassed: final immutable lock publication is a separate gate.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw Error('Usage: node scripts/test-local-typesafe.mjs <plugin-source> [--full]');
const source = path.resolve(process.argv[2]);
const directory = await mkdtemp(path.join(os.tmpdir(), 'local-typesafe-lock-'));
try {
  const lock = JSON.parse(await readFile(path.join(root, 'plugins.lock.json'), 'utf8'));
  for (const name of ['typesafe-api-plugin.ts', 'typesafe-decision-plugin.ts', 'typesafe-question-banks.ts']) lock.files[name] = '';
  for (const name of Object.keys(lock.files)) lock.files[name] = createHash('sha256').update(await readFile(path.join(source, 'src', name))).digest('hex');
  const localLock = path.join(directory, 'plugins.lock.json');
  await writeFile(localLock, JSON.stringify(lock));
  const run = args => {
    console.log(`[local-typesafe] ${process.execPath} ${args.join(' ')}`);
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, HARNESS_CORE_ROOT: root } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Development command failed (${result.status}): ${args[0]}`);
  };
  run(['scripts/materialize-plugins.mjs', source, localLock]);
  run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit']);
  run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
  run(['scripts/build-source-version.mjs']);
  run(['--import', 'tsx', '--test', path.join(source, 'test/typesafe-api-plugin.test.mjs'), path.join(source, 'test/typesafe-validator-provider.test.mjs')]);
  if (process.argv.includes('--full')) run(['scripts/test.mjs']);
  else run(['--import', 'tsx', '--test', 'test/typesafe-decisions.test.ts', 'test/typesafe-decision-artifact.test.ts', 'test/builtin-validator-artifact.test.ts']);
} finally { await rm(directory, { recursive: true, force: true }); }
