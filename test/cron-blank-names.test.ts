import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJobs } from '../src/scheduler.js';

test('cron job names must be non-empty without surrounding whitespace', () => {
  for (const name of ['""', '"   "', '" daily"', '"daily "']) {
    assert.throws(() => parseJobs(`jobs:\n  - name: ${name}\n    schedule: "0 * * * *"\n    prompt: x\n`), /Invalid cron job name/);
  }
  assert.equal(parseJobs('jobs:\n  - name: daily report\n    schedule: "0 * * * *"\n    prompt: x\n')[0].name, 'daily report');
});
