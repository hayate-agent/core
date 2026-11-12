import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Explicit local development lock is allowed only together with local sources.
// Production builds continue to use the checked-in immutable revision/hash lock.
const vendored = path.join(root, 'vendor/plugins');
const localSource = process.argv[2] || process.env.HAYATE_PLUGIN_SOURCE || (existsSync(vendored) ? vendored : undefined);
const localLock = process.argv[3];
// Public snapshot includes the exact locked plugin sources for offline builds.
const sources = process.argv[2] || path.join(root, 'vendor/plugins');
if (localLock && !localSource) throw Error('Local plugin lock requires local sources');
const lock = JSON.parse(await readFile(localLock ? path.resolve(localLock) : path.join(root, 'plugins.lock.json'), 'utf8'));
if (lock.schema !== 1 || !/^[a-f0-9]{40}$/.test(lock.revision) || !['https://git.vanillacore.net/harness/plugins', 'https://github.com/hayate-agent/plugins'].includes(lock.repository)) throw Error('Invalid plugin lock');
const output = path.join(root, 'src/builtin-plugins');
const files = [];
for (const [name, digest] of Object.entries(lock.files)) {
  if (!/^[a-z][a-z0-9-]*\.ts$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid locked plugin');
  const source = localSource
    ? await readFile(path.join(path.resolve(localSource), 'src', name), 'utf8')
    : await (async () => {
      const url = lock.repository === 'https://github.com/hayate-agent/plugins'
        ? `https://raw.githubusercontent.com/hayate-agent/plugins/${lock.revision}/src/${name}`
        : `${lock.repository}/raw/commit/${lock.revision}/src/${name}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error(`Plugin download failed: ${response.status}`);
      return response.text();
    })();
  if (createHash('sha256').update(source).digest('hex') !== digest) throw Error(`Plugin digest mismatch: ${name}`);
  files.push([name, source.replace(/(from\s+|import\()(["'])\.\/([^"']+)\2/g, (match, prefix, quote, specifier) => {
    const peer = specifier.replace(/\.js$/, '.ts');
    return `${prefix}${quote}${Object.hasOwn(lock.files, peer) ? './' : '../'}${specifier}${quote}`;
  })]);
}
// Verify every source before replacing generated output. Never run downloaded code.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const [name, source] of files) await writeFile(path.join(output, name), '// Generated from harness/plugins; edit the source repository.\n' + source);
