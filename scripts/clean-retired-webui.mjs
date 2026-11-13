import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only generated build outputs from the removed Plugins frontend. Never touch
 * installed operator plugins, home/config/state, or the separate dashboard. */
export async function cleanRetiredWebUI(root) {
  for (const parent of ['optional-plugins', 'dist', 'dist/optional-plugins']) {
    try { if ((await lstat(path.join(root, parent))).isSymbolicLink()) throw Error(`Refuse retired frontend cleanup through symlink: ${parent}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const relative of ['optional-plugins/webui', 'dist/optional-plugins/webui'])
    await rm(path.join(root, relative), { recursive: true, force: true });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await cleanRetiredWebUI(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
