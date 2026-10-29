import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness } from '../src/harness.js';
import { PluginHost } from '../src/plugins.js';
import { toolGuardDenialReason } from '../src/tool-guard-error.js';
import { continuationPlugin } from '../src/builtin-plugins/continuation-plugin.js';
import { FakeRuntime, MemoryChannel } from './fakes.js';

for (const depth of [19, 20]) {
  test(`real tick + registered routine wait preserves PR144 accounting at depth ${depth}`, async () => {
    const key = 'mem:room1';
    const deadline = 900000;
    const host = new PluginHost();
    const channel = new MemoryChannel(); channel.editableProgress = true;
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, now: () => 61000 });
    h.addChannel(channel);
    h.onStateChange = async () => {};
    h.restoreSessions([{ key, replyTo: { channel: 'mem', target: 'room1' }, task: {
      id: 'task', original: 'Inspect authorized worker', state: 'waiting', depth,
      next: 'inspect worker', wait: { reason: 'worker result', nextAt: 61000, deadline },
    } }]);
    await host.load([], { home: '/tmp', cwd: '/tmp', agent: 'fixture' }, [], [], [continuationPlugin(h)]);
    const session = await h.sessionFor(key);
    let checked = false;
    session.prompt = async () => {
      await h.guardWaitTool(key, 'plugin_dispatch', { action: 'status' });
      assert.equal(h.state(key).task!.depth, depth, 'status is budget-free');
      if (depth === 20) {
        await assert.rejects(h.guardWaitTool(key, 'bash', {}), error => {
          assert.match(toolGuardDenialReason(error), /^continuation_budget_exhausted:/);
          return true;
        });
      } else {
        await h.guardWaitTool(key, 'bash', {});
        await h.guardWaitTool(key, 'plugin_dispatch', { action: 'submit' });
        assert.equal(h.state(key).task!.depth, 20, 'productive tools charge once per recheck');
      }
      await h.guardWaitTool(key, 'plugin_task_continuation', {});
      await host.tools.get('plugin_task_continuation')!.execute({
        state: 'waiting', next: 'inspect worker', replyKind: 'routine',
        wait: { reason: 'worker result', retryAfterMs: 60000, deadline },
      }, { sessionKey: key } as never);
      checked = true;
      return 'Still waiting.';
    };
    try {
      await h.tick(); await h.drained();
      assert.ok(checked);
      assert.equal(channel.sent.length, depth === 20 ? 2 : 1);
      if (depth === 20) assert.match(channel.sent[0].text, /Aktionsbudget erschöpft/);
      assert.equal(channel.sent.at(-1)!.meta?.presentation, 'progress');
      const task = h.snapshotSessions()[0].task!;
      assert.equal(task.depth, 20);
      assert.equal(task.waitChecks, 1);
      assert.equal(task.wait!.deadline, deadline);
      assert.equal(task.state, 'waiting');
      assert.equal(task.termination, undefined);
    } finally { await h.stop(0); await host.stop(); }
  });
}
