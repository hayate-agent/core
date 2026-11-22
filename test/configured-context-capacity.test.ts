import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { PiRuntime } from '../src/runtime/pi.js';
import { ContextMaintenance, contextPolicy } from '../src/context-maintenance.js';
import { modelInputLimit } from '../src/model-input-budget.js';

test('explicit capacity is bounded by physical input/headroom, not the historical default', () => {
  assert.equal(modelInputLimit(262144, 1050000, 32768), 262144);
  assert.equal(modelInputLimit(262144, 200000, 32768), 167232);
  assert.equal(modelInputLimit(65536, 1050000, 32768), 65536);
  assert.equal(modelInputLimit(262144, 0, 32768), 262144);
});

for (const key of ['matrix:odo', 'dispatch:batch:claim']) test(`SDK and host respect configured role capacity: ${key}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'configured-capacity-'));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, 'agent');
  t.after(async () => {
    for (const [k, v] of Object.entries(previous)) v === undefined ? delete process.env[k] : process.env[k] = v;
    await rm(home, { recursive: true, force: true });
  });
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  let inputTokens = 81014;
  models.registerProvider('capacity-fixture', { api: 'openai-completions', baseUrl: 'https://fixture.invalid',
    apiKey: ['synthetic', 'fixture'].join('-'),
    models: [{ id: 'model', name: 'Configured capacity', reasoning: false, input: ['text'], contextWindow: 1050000, maxTokens: 32768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: model => {
      const stream = createAssistantMessageEventStream();
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'Verified batch receipt; pending effect remains uncertain.' }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: inputTokens, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + 6,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream;
    } });
  const policy = contextPolicy({ mainContextTokens: 262144, workerContextTokens: 196608 });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, 'sessions'), model: 'capacity-fixture/model', tools: [],
    skillPaths: [], personaSections: async () => [], contextBudgets: () => policy, compactionOwner: () => 'harness', approvals: { mode: 'off', tools: [] } });
  (runtime as any).modelRuntime = async () => models;
  const wrapped: any = await runtime.open(key);
  try {
    await wrapped.prompt('Continue the authorized batch with exact receipts; never replay uncertain effects.');
    const expected = key.startsWith('matrix:') ? 262144 : 196608;
    assert.equal(wrapped.status().contextBudgetTokens, expected);
    const model = wrapped.session.model;
    assert.equal(model.contextWindow - wrapped.session.settingsManager.getCompactionSettings(model).reserveTokens, expected);
    if (key.startsWith('matrix:')) {
      let assessments = 0, rotations = 0;
      const maintenance = new ContextMaintenance(home, () => policy, async () => { assessments++; return 'handover'; }, Date.now,
        async () => 'CURRENT STATE AND NEXT STEPS: preserve batch receipts and pending effects.');
      for (let i = 0; i < 6; i++) {
        await maintenance.beforeTurn(key, wrapped, async () => { rotations++; throw Error('spurious rotation'); });
        await wrapped.prompt(`Reconcile distinct batch item ${i}; preserve previous receipts.`);
      }
      assert.equal(rotations, 0); assert.equal(assessments, 0, '81k is not pressure against the configured 262k capacity');
      // Actual high pressure still enters the host boundary gate.
      inputTokens = 170000; await wrapped.prompt('Genuine high context; preserve all evidence.');
      await maintenance.beforeTurn(key, wrapped, async () => { rotations++; throw Error('real pressure'); });
      assert.equal(assessments, 1); assert.equal(rotations, 1);
    }
  } finally { await wrapped.dispose(); }
});
