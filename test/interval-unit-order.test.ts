import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInterval } from '../src/interval.js';
import { COMMANDS, type CommandContext } from '../src/commands.js';
import { Harness } from '../src/harness.js';
import { FakeRuntime } from './fakes.js';

test('interval parser rejects repeated or non-descending units instead of summing them', () => {
  for (const s of ['5m5m', '1m1m1m', '30m1h', '1s1d', '0m1h', '1h1h30m', '1m30s1m']) assert.equal(parseInterval(s), undefined, s);
  for (const [s, ms] of [['30m', 1_800_000], ['1h30m', 5_400_000], ['1d2h', 93_600_000], ['1m30s', 90_000], ['1h0m', 3_600_000], ['90m', 5_400_000], ['1d1h1m1s', 90_061_000]] as const)
    assert.equal(parseInterval(s), ms, s);
});

test('/loop and /heartbeat refuse repeated units and install nothing', async (t) => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, log: () => {} });
  harness.onStateChange = async () => {};
  t.after(() => harness.stop(0));
  const run = (name: string, args: string, key: string) =>
    COMMANDS.find(c => c.name === name)!.run(args, { sessionKey: key, source: 'channel', text: '' } as any, { harness } as CommandContext);
  assert.match(String(await run('loop', '5m5m synthetic', 'loop-probe')), /invalid interval/);
  assert.equal(harness.state('loop-probe').loop, undefined);
  assert.match(String(await run('heartbeat', 'every 30m1h synthetic', 'hb-probe')), /invalid interval/);
  assert.equal(harness.state('hb-probe').heartbeat, undefined);
  assert.match(String(await run('loop', '1h30m synthetic', 'ok-probe')), /every 90m/);
});
