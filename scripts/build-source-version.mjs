// Build-time provenance for native Git installs, including bootstrap by an older
// owner that still writes package.json's base version into build-info.json.
// This is informational metadata, never a new installation/test gate.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceVersion } from '../dist/source-version.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = path.dirname(root);
// Never fetch into an operator/developer worktree or at runtime startup.
if (/^[a-f0-9-]{36}$/.test(path.basename(parent)) &&
    path.basename(path.dirname(parent)) === 'releases' &&
    path.basename(path.dirname(path.dirname(parent))) === 'software-updates' &&
    existsSync(path.join(root, '.git')) &&
    existsSync(path.join(parent, 'plugins')) && existsSync(path.join(parent, 'webui/package.json'))) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000,
    killSignal: 'SIGTERM', maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const revision = git('rev-parse', 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('invalid source revision');
    let tags = '', history = '';
    try {
      git('fetch', '--depth=64', 'origin', revision);
      tags = git('ls-remote', '--tags', 'origin');
      history = git('rev-list', '--first-parent', '--max-count=64', revision);
    } catch { /* An offline build retains an explicit development/source label. */ }
    const corePackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const info = { version: sourceVersion(revision, tags, history, corePackage.version), revision };
    // This is the separately installed frontend package, not proof that its
    // standalone server is running or replacing the bundled local gateway.
    try {
      const web = path.join(parent, 'webui');
      const command = (...args) => execFileSync('git', args, { cwd: web, encoding: 'utf8', timeout: 5000,
        killSignal: 'SIGTERM', maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const revision = command('rev-parse', 'HEAD');
      let tags = '', history = '';
      try {
        command('fetch', '--depth=64', 'origin', revision);
        tags = command('ls-remote', '--tags', 'origin');
        history = command('rev-list', '--first-parent', '--max-count=64', revision);
      } catch { /* No extra release/installation gate. */ }
      const pkg = JSON.parse(await readFile(path.join(web, 'package.json'), 'utf8'));
      info.webPackage = { version: sourceVersion(revision, tags, history, pkg.version), revision };
    } catch { /* No independently installed Web package metadata. */ }
    await writeFile(path.join(root, 'dist/source-build-info.json'), JSON.stringify(info) + '\n');
  } catch { console.error('[build-info] optional source-version metadata unavailable'); }
}
