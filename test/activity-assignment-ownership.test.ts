import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnActivity, type ActivityEvent } from '../src/activity.js';

test('activity retains the original host assignment after caller mutation', () => {
  const input = { id: 'original', parent: 'original-parent', role: 'main' as const, context: 'operator' as const, outputTags: ['original'] };
  const events: ActivityEvent[] = [];
  const activity = new TurnActivity(input, event => events.push(event));
  try {
    const before = activity.snapshot();
    Object.assign(input, { id: 'replacement', parent: 'replacement-parent', role: 'worker', context: 'worker' });
    input.outputTags.push('replacement');
    activity.running();
    const after = events.at(-1)!.snapshot;
    assert.equal(after.id, before.id);
    assert.equal(after.parent, before.parent);
    assert.equal(after.role, before.role);
    assert.equal(after.context, before.context);
    assert.deepEqual(after.outputTags, ['original']);
    after.outputTags!.push('sink mutation');
    assert.deepEqual(activity.snapshot().outputTags, ['original']);
  } finally { activity.finish('completed'); }
});

test('assignment ownership also holds for disabled activity and absent tags', () => {
  const input = { id: 'original', role: 'main' as const, context: 'operator' as const };
  let emissions = 0;
  const activity = new TurnActivity(input, () => { emissions++; }, { enabled: false });
  const before = activity.snapshot();
  input.id = 'replacement';
  activity.running(); activity.finish('cancelled');
  assert.equal(activity.snapshot().id, before.id);
  assert.equal(activity.snapshot().outputTags, undefined);
  assert.equal(emissions, 0);
});
