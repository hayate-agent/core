import { readFile, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'optional-plugins/webui');
const output = path.join(root, 'dist/optional-plugins/webui');
// All inputs were checked against plugin-assets.lock.json. Disable dependency
// lifecycle scripts; bundle the browser with the exact locked esbuild instead.
// No gateway factory, activation function or operator module is executed.
execFileSync('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-fund'], { cwd: source, stdio: 'inherit' });
execFileSync(path.join(source, 'node_modules/.bin/esbuild'), [
  'public/app.js', '--bundle', '--format=esm', '--minify', '--outfile=public/app.bundle.js'], { cwd: source, stdio: 'inherit' });
const files = ['index.mjs', 'ui.mjs', 'README.md', 'public/index.html', 'public/style.css', 'public/app.bundle.js'];
await rm(output, { recursive: true, force: true });
const digests = {};
for (const file of files) {
  await mkdir(path.dirname(path.join(output, file)), { recursive: true });
  await copyFile(path.join(source, file), path.join(output, file));
  digests[file] = createHash('sha256').update(await readFile(path.join(output, file))).digest('hex');
}
const lock = JSON.parse(await readFile(path.join(root, 'plugin-assets.lock.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
const version = typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version) ? pkg.version : undefined;
await writeFile(path.join(output, 'provenance.json'), JSON.stringify({ schema: 1, version, plugin: lock.plugins.find(p => p.name === 'webui'), files: digests }, null, 2) + '\n');
