import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, type CommandContext } from '../src/commands.js';
import { Harness } from '../src/harness.js';
import { FakeRuntime } from './fakes.js';

test('/loop and /heartbeat retain minimum interval for millisecond input', async (t) => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, log: () => {} });
  harness.onStateChange = async () => {};
  t.after(() => harness.stop(0));
  for (const name of ['loop', 'heartbeat'] as const) {
    const key = `ms-${name}`;
    const args = name === 'loop' ? '1ms synthetic' : 'every 1ms synthetic';
    const result = await COMMANDS.find(c => c.name === name)!.run(args,
      { sessionKey: key, source: 'channel', text: '' } as any, { harness } as CommandContext);
    assert.match(String(result), /minimum interval is 1m/i);
    assert.equal(harness.state(key)[name], undefined);
  }
});
