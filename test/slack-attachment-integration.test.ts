import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Harness } from '../src/harness.js';
import { FakeRuntime } from './fakes.js';

// Optional explicit local compatibility check against a pinned candidate plugin tree.
// Default suite never downloads or executes a guessed checkout.
const pluginRoot = process.env.SLACK_GATEWAY_CANDIDATE;
test('real gateway download -> durable channel acceptance -> actual runtime image block', { skip: !pluginRoot }, async () => {
  const { SlackGateway } = await import(pathToFileURL(path.join(pluginRoot!, 'src/slack-gateway.mjs')).href);
  const { SlackFiles } = await import(pathToFileURL(path.join(pluginRoot!, 'src/slack-files.mjs')).href);
  const root = await mkdtemp(path.join(os.tmpdir(), 'slack-integration-'));
  let harness: Harness | undefined;
  try {
    const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
    const runtime = new FakeRuntime();
    harness = new Harness({ runtime, attachmentRoot: root });
    harness.onStateChange = async () => {};
    const gateway = new SlackGateway({ teamId: 'T1', channels: ['C1'], files: new SlackFiles({
      root, botToken: 'fake', fetch: async () => new Response(bytes),
    }) }, { fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }) });
    harness.addChannel(gateway);
    gateway.botId = 'UBOT'; gateway.deliver = (input: any) => harness!.accept(input);
    let ack = false;
    await gateway.receive(JSON.stringify({ type: 'events_api', envelope_id: 'envelope', payload: {
      team_id: 'T1', event_id: 'Ev1', event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1.001', text: '<@UBOT> describe',
        files: [{ id: 'F123', size: bytes.length, name: 'image.png', url_private: 'https://files.slack.com/files-pri/T1-F123/x' }] },
    } }), { send() { ack = true; } });
    assert.equal(ack, true);
    for (let i = 0; i < 100 && !runtime.sessions.get('slack:T1:C1:1.001')?.prompts.length; i++) await new Promise(r => setTimeout(r, 2));
    assert.deepEqual(runtime.sessions.get('slack:T1:C1:1.001')!.options[0].images,
      [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }]);
  } finally { await harness?.stop(); await rm(root, { recursive: true, force: true }); }
});
