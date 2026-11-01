import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardResultOrchestration } from '../src/result-orchestration.js';
import type { Harness } from '../src/harness.js';

// API result turns can legitimately have no stored continuation mandate.
// The outer host-event guard still validates completed execution ownership.
function resultWithoutMandate(): Harness {
  return {
    sessions: new Map([['api:acceptance', { current: { source: 'host' } }]]),
    resultMandate: () => undefined,
  } as unknown as Harness;
}

test('result without productive mandate may reread existing dispatcher status/result', () => {
  const h = resultWithoutMandate();
  for (const args of [{ action: 'status', id: 'existing' }, { action: 'status', id: 'existing', field: 'result' }]) {
    assert.doesNotThrow(() => guardResultOrchestration(h, 'api:acceptance', 'plugin_dispatch', args));
  }
});

test('result status exception does not authorize productive orchestration or cancellation', () => {
  const h = resultWithoutMandate();
  for (const action of ['submit', 'cancel', 'retry', undefined]) {
    assert.throws(() => guardResultOrchestration(h, 'api:acceptance', 'plugin_dispatch', { action }), /live stored parent mandate/);
  }
  for (const tool of ['plugin_subagent', 'plugin_loop', 'plugin_task_continuation', 'plugin_improvement_evaluate']) {
    assert.throws(() => guardResultOrchestration(h, 'api:acceptance', tool, { state: 'continue' }), /live stored parent mandate/);
  }
});
