import { mkdtempSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Canonical, short paths avoid macOS /var symlinks and Unix socket path limits.
const temporary = mkdtempSync(path.join(realpathSync(process.platform === 'darwin' ? '/tmp' : os.tmpdir()), 'hy-'));
try {
  const tests = readdirSync('test').filter(name => name.endsWith('.test.ts')).sort().map(name => `test/${name}`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
    stdio: 'inherit', env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
