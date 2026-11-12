import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 300 &&
  /^[a-zA-Z0-9_.\/-]+$/.test(value) && !value.startsWith('/') &&
  value.split('/').every(part => part && part !== '.' && part !== '..');

/** Build-time only: verify trusted optional-plugin source assets; never execute them. */
export async function materializeAssets(lock, output, load) {
  if (lock?.schema !== 1 || !Array.isArray(lock.plugins)) throw Error('Invalid optional plugin asset lock');
  const names = new Set();
  const verified = [];
  for (const plugin of lock.plugins) {
    if (!/^[a-z][a-z0-9-]*$/.test(plugin.name) || names.has(plugin.name) ||
        !['https://git.vanillacore.net/harness/plugins', 'https://github.com/hayate-agent/plugins'].includes(plugin.repository) ||
        !/^[a-f0-9]{40}$/.test(plugin.revision) || !relative(plugin.source) ||
        !plugin.files || typeof plugin.files !== 'object' || Array.isArray(plugin.files) || !Object.keys(plugin.files).length) {
      throw Error('Invalid optional plugin identity');
    }
    names.add(plugin.name);
    for (const [file, digest] of Object.entries(plugin.files)) {
      if (!relative(file) || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid optional plugin asset');
      const bytes = Buffer.from(await load(plugin, file));
      if (createHash('sha256').update(bytes).digest('hex') !== digest) throw Error(`Optional plugin digest mismatch: ${plugin.name}/${file}`);
      verified.push([plugin.name, file, bytes]);
    }
  }
  // Validate every source before replacing generated output. No imported plugin code runs here.
  const stage = `${output}.${randomUUID()}.stage`;
  try {
    await mkdir(stage, { recursive: true });
    for (const [name, file, bytes] of verified) {
      const destination = path.join(stage, name, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await writeFile(path.join(stage, 'provenance.json'), JSON.stringify(lock, null, 2) + '\n');
    await rm(output, { recursive: true, force: true });
    // Build-local output, not a runtime hot replacement or a persistent data store.
    const { rename } = await import('node:fs/promises');
    await rename(stage, output);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(await readFile(path.join(root, 'plugin-assets.lock.json'), 'utf8'));
  const localSource = process.argv[2] || process.env.HAYATE_PLUGIN_SOURCE;
  const local = localSource ? path.resolve(localSource) : undefined;
  const pinnedSources = process.env.HAYATE_PLUGIN_ASSET_SOURCES ? JSON.parse(process.env.HAYATE_PLUGIN_ASSET_SOURCES) : {};
  await materializeAssets(lock, path.join(root, 'optional-plugins'), async (plugin, file) => {
    const pinned = pinnedSources[plugin.revision];
    if (pinned !== undefined && (typeof pinned !== 'string' || !path.isAbsolute(pinned))) throw Error('Invalid pinned asset source');
    if (pinned || local) return readFile(path.join(pinned || local, plugin.source, file));
    const vendored = path.join(root, 'vendor/plugin-assets');
    if (existsSync(vendored)) return readFile(path.join(vendored, plugin.revision, plugin.source, file));
    const url = plugin.repository === 'https://github.com/hayate-agent/plugins'
      ? `https://raw.githubusercontent.com/hayate-agent/plugins/${plugin.revision}/${plugin.source}/${file}`
      : `${plugin.repository}/raw/commit/${plugin.revision}/${plugin.source}/${file}`;
    const response = await fetch(url,
      { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw Error(`Optional plugin download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  });
}
