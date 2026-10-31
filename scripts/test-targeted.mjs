import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = value => value.split(path.sep).join('/');
function filesUnder(root, dir) {
  if (!existsSync(path.join(root, dir))) return [];
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(root, file) : [file];
  });
}

// Deliberately local: no persisted dependency index, execution of source, or CI policy changes.
export function selectTests(root, changed) {
  const files = ['src', 'test', 'scripts'].flatMap(dir => filesUnder(root, dir));
  const modules = new Set(files.filter(file => /\.(ts|mjs)$/.test(file)));
  const tests = files.filter(file => /^test\/[^/]+\.test\.ts$/.test(file)).sort();
  const full = reason => ({ mode: 'full', reason, tests });
  if (!changed.length) return { mode: 'none', reason: 'No changed files', tests: [] };
  // These contracts affect runtime wiring, generated code or the runner itself beyond static imports.
  const contracts = new Set(['src/types.ts', 'src/config.ts', 'src/cli.ts', 'src/plugins.ts']);
  for (const file of changed) {
    if (contracts.has(file) || file.startsWith('src/builtin-plugins/')) return full(`Shared/runtime contract: ${file}`);
    if (!modules.has(file)) return full(`Unknown, deleted or non-module change: ${file}`);
  }
  const reverse = new Map();
  for (const file of modules) {
    const source = readFileSync(path.join(root, file), 'utf8');
    // Literal import/export-from, side-effect imports, import types and dynamic import/require.
    // Comments/string examples may over-select; this is a conservative local heuristic, not a bundler.
    const imports = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["'](\.[^"'\r\n]+)["']/g;
    for (const match of source.matchAll(imports)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
        const resolved = [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}/index.ts`].find(candidate => modules.has(candidate));
        if (resolved) {
          if (!reverse.has(resolved)) reverse.set(resolved, new Set());
          reverse.get(resolved).add(file);
        }
    }
  }
  const selected = new Set();
  for (const file of changed) {
    const seen = new Set([file]);
    for (const current of seen) for (const importer of reverse.get(current) ?? []) seen.add(importer);
    const affected = tests.filter(test => seen.has(test));
    if (!affected.length) return full(`No static test coverage: ${file}`);
    for (const test of affected) selected.add(test);
  }
  return { mode: 'targeted', reason: 'Changed modules and transitive static importers (including type imports)', tests: [...selected].sort() };
}

export function changedFiles(root, base) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  // No rename inference: both old and new paths must participate. Include staged, unstaged and untracked.
  return [...new Set([
    ...git(['diff', '--name-only', '--no-renames', '-z', ...(base ? [base] : ['HEAD']), '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']),
  ])];
}

export function main(args, cwd = root) {
  let base;
  let list = false;
  const explicit = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    else if (args[i] === '--base' && args[i + 1] && !args[i + 1].startsWith('-')) base = args[++i];
    else if (args[i].startsWith('-')) throw Error(`Unknown or incomplete option: ${args[i]}`);
    else explicit.push(posix(args[i]).replace(/^\.\//, ''));
  }
  if (base && explicit.length) throw Error('Use --base OR explicit repository-relative files');
  const result = selectTests(cwd, explicit.length ? explicit : changedFiles(cwd, base));
  console.log(JSON.stringify(result, null, 2));
  if (list || result.mode === 'none') return 0;
  // Preserve the existing generated-plugin prerequisite, only when actually running tests.
  const prepare = spawnSync(process.execPath, ['scripts/materialize-plugins.mjs'], { cwd, stdio: 'inherit' });
  if (prepare.error) throw prepare.error;
  if (prepare.status !== 0) return prepare.status ?? 1;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...result.tests], { cwd, stdio: 'inherit' });
  if (run.error) throw run.error;
  return run.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
