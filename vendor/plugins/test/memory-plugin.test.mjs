import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryPlugin } from '../src/memory-plugin.ts';

function setup() {
  let tool;
  const writes = [];
  memoryPlugin({ provider: {
    async put(context, entry) { writes.push({ context, entry }); return { id: 'saved' }; },
    async search() { return []; },
  } }).activate({ registerTool(value) { tool = value; }, registerCommand() {} });
  return { tool, writes };
}
const valid = { key: 'decision:memory-contract:v1', title: 'Decision', text: 'Preserve stable retry keys.' };

test('put advertises required fields, provider limits and stable retry semantics', () => {
  const { tool } = setup();
  assert.deepEqual(tool.parameters.properties.entry.required, ['key', 'title', 'text']);
  assert.equal(tool.parameters.properties.entry.properties.key.maxLength, 500);
  assert.equal(tool.parameters.properties.entry.properties.title.maxLength, 300);
  assert.equal(tool.parameters.properties.entry.properties.text.maxLength, 12000);
  assert.match(tool.description, /same key and unchanged content/);
  assert.deepEqual(tool.parameters.required, ['action']);
});

test('invalid writes never reach a provider and errors name the missing field', async () => {
  const { tool, writes } = setup();
  for (const entry of [undefined, null, [], 'wrong']) {
    await assert.rejects(tool.execute({ action: 'put', entry }, { sessionKey: 'conversation' }), /requires entry/);
  }
  for (const [field, limit] of [['key', 500], ['title', 300], ['text', 12000]]) {
    for (const value of [undefined, '', '   ', 42, 'x'.repeat(limit + 1)]) {
      await assert.rejects(tool.execute({ action: 'put', entry: { ...valid, [field]: value } }, { sessionKey: 'conversation' }), new RegExp('entry\\.' + field));
    }
  }
  assert.equal(writes.length, 0);
});

test('host context is required and cannot be supplied through the entry', async () => {
  const { tool, writes } = setup();
  for (const sessionKey of [undefined, '', 42, 'x'.repeat(1001)]) {
    await assert.rejects(tool.execute({ action: 'put', entry: { ...valid, sessionKey: 'forged' } }, { sessionKey }), /host conversation context/);
  }
  assert.equal(writes.length, 0);
});

test('valid writes preserve retry key and payload; read actions need no entry', async () => {
  const { tool, writes } = setup();
  const context = { sessionKey: 'conversation' };
  await tool.execute({ action: 'put', entry: valid }, context);
  await tool.execute({ action: 'put', entry: valid }, context);
  assert.deepEqual(writes, [{ context, entry: valid }, { context, entry: valid }]);
  assert.equal(await tool.execute({ action: 'search', query: 'memory' }, context), '[]');
});
