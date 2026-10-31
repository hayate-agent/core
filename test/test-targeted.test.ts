import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
// The selector is a Node ESM development script, not part of the shipped runtime.
import { selectTests, changedFiles } from '../scripts/test-targeted.mjs';

function fixture(t: any, files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'test-selector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), source);
  }
  return root;
}
const sources = {
  'src/leaf.ts': 'export const value = 1;',
  'src/barrel.ts': 'export { value } from "./leaf.js";',
  'src/consumer.ts': 'import type { value } from "./barrel.js";',
  'test/causal.test.ts': 'import "../src/consumer.js";',
  'test/dynamic.test.ts': 'await import("../src/leaf.js");',
  'test/type.test.ts': 'type T = import("../src/leaf.js").T;',
  'test/unrelated.test.ts': 'export {};',
};

test('selects causal transitive, re-exported, type and literal dynamic importers, not unrelated tests', t => {
  const root = fixture(t, sources);
  assert.deepEqual(selectTests(root, ['src/leaf.ts']), {
    mode: 'targeted', reason: 'Changed modules and transitive static importers (including type imports)',
    tests: ['test/causal.test.ts', 'test/dynamic.test.ts', 'test/type.test.ts'],
  });
  // Removing the causal edge must remove the corresponding test from the selection.
  writeFileSync(path.join(root, 'src/barrel.ts'), 'export {};');
  assert.deepEqual(selectTests(root, ['src/leaf.ts']).tests, ['test/dynamic.test.ts', 'test/type.test.ts']);
});

test('handles cycles, changed tests, union and deterministic deduplication', t => {
  const root = fixture(t, { ...sources, 'src/leaf.ts': 'import "./barrel.js";' });
  assert.deepEqual(selectTests(root, ['test/unrelated.test.ts']).tests, ['test/unrelated.test.ts']);
  assert.deepEqual(selectTests(root, ['src/barrel.ts', 'src/leaf.ts', 'src/leaf.ts']).tests,
    ['test/causal.test.ts', 'test/dynamic.test.ts', 'test/type.test.ts']);
  assert.equal(selectTests(root, []).mode, 'none');
});

test('contracts, unknown paths, deleted modules and uncovered source force explicit full fallback', t => {
  const root = fixture(t, { ...sources, 'src/uncovered.ts': 'export {};', 'src/types.ts': 'export {};' });
  for (const file of ['src/types.ts', 'src/config.ts', 'src/plugins.ts', 'src/cli.ts', 'src/builtin-plugins/x.ts',
    'package.json', 'plugins.lock.json', 'docs/development.md', 'test/fixture.json', 'src/deleted.ts', 'src/uncovered.ts']) {
    const result = selectTests(root, ['src/leaf.ts', file]);
    assert.equal(result.mode, 'full', file);
    assert.ok(result.reason.includes(file), file);
    assert.deepEqual(result.tests, Object.keys(sources).filter(f => f.startsWith('test/')).sort());
  }
});

test('git discovery includes staged, unstaged, untracked, deleted and both rename paths; base includes committed changes', t => {
  const root = fixture(t, { ...sources, 'src/delete.ts': 'export {};' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  // Fixture-only commits, never in the task worktree or a foreign checkout.
  git('-c', 'user.name=Severus Snape', '-c', 'user.email=severus-snape@agents.vanillacore.net', 'commit', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD').trim();
  writeFileSync(path.join(root, 'src/leaf.ts'), 'export const value = 2;');
  git('add', '.');
  git('-c', 'user.name=Severus Snape', '-c', 'user.email=severus-snape@agents.vanillacore.net', 'commit', '-qm', 'fixture change');
  git('mv', 'src/barrel.ts', 'src/renamed.ts');
  writeFileSync(path.join(root, 'src/consumer.ts'), 'export {};');
  writeFileSync(path.join(root, 'test/new name.test.ts'), 'export {};');
  rmSync(path.join(root, 'src/delete.ts'));
  assert.deepEqual(changedFiles(root).sort(), ['src/barrel.ts', 'src/consumer.ts', 'src/delete.ts', 'src/renamed.ts', 'test/new name.test.ts']);
  assert.ok(changedFiles(root, base).includes('src/leaf.ts'));
  assert.equal(selectTests(root, changedFiles(root)).mode, 'full');
  assert.throws(() => changedFiles(root, 'missing-base'));
});

test('runner actually executes selected tests, propagates failures, and stops on prerequisite failure', t => {
  const root = fixture(t, {
    'scripts/materialize-plugins.mjs': 'process.exitCode = 0;',
    'test/pass.test.ts': 'import test from "node:test"; test("pass", () => {});',
    'test/fail.test.ts': 'import test from "node:test"; test("fail", () => { throw Error("causal failure"); });',
  });
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Exercise a genuine CLI invocation outside the parent test runner.
  const run = (file: string) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { main } from ${JSON.stringify(new URL('../scripts/test-targeted.mjs', import.meta.url).href)}; process.exitCode = main([${JSON.stringify(file)}], ${JSON.stringify(root)});`,
  ], { env, encoding: 'utf8' });
  assert.equal(run('test/pass.test.ts').status, 0);
  const failed = run('test/fail.test.ts');
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /causal failure/);
  writeFileSync(path.join(root, 'scripts/materialize-plugins.mjs'), 'process.exitCode = 23;');
  assert.equal(run('test/pass.test.ts').status, 23);
});

test('CLI list is executable without materialization, rejects bad options and supports concrete test paths', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/test-targeted.mjs', ...args], { encoding: 'utf8' });
  const result = run('--list', 'test/test-targeted.test.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).tests, ['test/test-targeted.test.ts']);
  const unknown = run('--list', 'not-a-known-contract');
  assert.equal(JSON.parse(unknown.stdout).mode, 'full');
  for (const args of [['--base'], ['--typo'], ['--base', 'HEAD', 'src/leaf.ts']]) {
    assert.equal(run(...args).status, 1);
  }
});
