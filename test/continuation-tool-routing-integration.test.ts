import { confirmNonproductive } from "./fakes.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness } from '../src/harness.js';
import { PluginHost } from '../src/plugins.js';
import { continuationPlugin } from '../src/builtin-plugins/continuation-plugin.js';
import { FakeRuntime, MemoryChannel, ROOM, msg } from './fakes.js';

const wait = { reason: 'worker result', retryAfterMs: 60000, deadline: 900000 };

test('registered materialized continuation tool routes entire replies through real Core', async () => {
  for (const replyKind of [undefined, 'routine', 'substantive'] as const) {
    for (const changed of [false, true]) {
      const channel = new MemoryChannel();
      channel.editableProgress = true;
      const host = new PluginHost();
      let h: Harness;
      const text = replyKind === 'routine' ? 'Still waiting.' : 'Partial result: 32 records; approval required.';
      const runtime = new FakeRuntime((async () => {
        const tool = host.tools.get('plugin_task_continuation')!;
        assert.deepEqual((tool.parameters.properties!.replyKind as { enum: string[] }).enum, ['routine', 'substantive']);
        await tool.execute({ state: 'waiting', next: changed ? 'inspect other worker' : 'inspect worker', wait,
          ...(replyKind === undefined ? {} : { replyKind }) }, { sessionKey: 'mem:room1' } as never);
        return text;
      }) as never);
      h = new Harness({ completionCheck: confirmNonproductive, runtime, now: () => 1000 }); h.onStateChange = async () => {};
      h.addChannel(channel);
      await host.load([], { home: '/tmp', cwd: '/tmp', agent: 'fixture' }, [], [], [continuationPlugin(h)]);
      try {
        await h.start();
        await h.accept({ source: 'cron', sessionKey: 'mem:room1', text: 'poll', taskId: 'task', replyTo: ROOM,
          waitRecheck: { reason: wait.reason, next: 'inspect worker' } });
        await h.drained();
        assert.equal(channel.sent.length, 1);
        assert.equal(channel.sent[0].text, text);
        assert.equal(channel.sent[0].meta?.presentation, replyKind === 'routine' && !changed ? 'progress' : undefined);
      } finally { await h.stop(0); await host.stop(); }
    }
  }
});

for (const busyMode of ['queue', 'steer', 'interrupt'] as const) {
  test(`${busyMode}: operator answer steered into a registered routine wait remains foreground chat`, async () => {
    const host = new PluginHost();
    const channel = new MemoryChannel(); channel.editableProgress = true;
    const runtime = new FakeRuntime();
    const h = new Harness({ completionCheck: confirmNonproductive, runtime, busyMode, now: () => 1000, tickMs: 60000 });
    h.onStateChange = async () => {}; h.addChannel(channel);
    await host.load([], { home: '/tmp', cwd: '/tmp', agent: 'fixture' }, [], [], [continuationPlugin(h)]);
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { finish = resolve; });
    try {
      await h.start(); await h.sessionFor('mem:room1');
      const session = runtime.sessions.get('mem:room1')!;
      session.prompt = async text => {
        session.prompts.push(text);
        await host.tools.get('plugin_task_continuation')!.execute({ state: 'waiting', next: 'inspect worker', wait,
          replyKind: 'routine' }, { sessionKey: 'mem:room1' } as never);
        entered(); await released;
        return 'Direct answer: worker A passed; worker B remains pending.';
      };
      await h.accept({ source: 'cron', sessionKey: 'mem:room1', text: 'poll', taskId: 'task', replyTo: ROOM,
        progressId: 'old-wait', waitRecheck: { reason: wait.reason, next: 'inspect worker' } });
      await started;
      await h.accept({ ...msg('What passed?'), id: 'operator-question', progressId: 'operator-progress' });
      assert.deepEqual(session.steered, ['What passed?']);
      assert.equal(session.aborted, 0);
      finish(); await h.drained();
      assert.deepEqual(session.prompts, ['poll'], 'the operator question was consumed by steering, not replayed');
      assert.equal(channel.sent.length, 1);
      assert.equal(channel.sent[0].text, 'Direct answer: worker A passed; worker B remains pending.');
      assert.equal(channel.sent[0].meta?.presentation, undefined, 'routine designation cannot suppress an operator answer');
      assert.equal(channel.sent[0].meta?.progressId, 'operator-progress');
      assert.equal(h.pendingInputs().length, 0);
    } finally { finish(); await h.stop(0); await host.stop(); }
  });
}

test('real Core rejects invalid replyKind through registered tool and leaves chat conservative', async () => {
  for (const replyKind of ['', 'quiet', null, 1, {}, ['routine']]) {
    const host = new PluginHost();
    const channel = new MemoryChannel();
    let h: Harness;
    const runtime = new FakeRuntime((async () => {
      await assert.rejects(host.tools.get('plugin_task_continuation')!.execute({ state: 'waiting', replyKind }, { sessionKey: 'mem:room1' } as never), /Invalid continuation reply kind/);
      return 'Attention required.';
    }) as never);
    h = new Harness({ completionCheck: confirmNonproductive, runtime, now: () => 1000 }); h.onStateChange = async () => {}; h.addChannel(channel);
    await host.load([], { home: '/tmp', cwd: '/tmp', agent: 'fixture' }, [], [], [continuationPlugin(h)]);
    try {
      await h.start();
      await h.accept({ source: 'cron', sessionKey: 'mem:room1', text: 'poll', taskId: 'task', replyTo: ROOM,
        waitRecheck: { reason: wait.reason, next: 'inspect worker' } });
      await h.drained();
      assert.equal(channel.sent[0]?.text, 'Attention required.');
      assert.equal(channel.sent[0]?.meta?.presentation, undefined);
    } finally { await h.stop(0); await host.stop(); }
  }
});
