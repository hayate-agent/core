import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountRepetition, repetitions } from '../src/repetition-budget.js';
import { Harness, type DurableTask } from '../src/harness.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';

test('baseline depth exhausts distinct work; versioned host evidence permits >20 without reusing queue depth', () => {
  const task: DurableTask = { id: 't', original: 'scope', state: 'active', depth: 0 };
  for (let i = 0; i < 40; i++) { accountRepetition(task, `tree${i}`, `tree${i+1}`); task.depth++; }
  assert.equal(task.depth, 40); assert.equal(repetitions(task), 0);
  const restored = JSON.parse(JSON.stringify(task));
  for (let i = 0; i < 20; i++) accountRepetition(restored, 'tree40', 'tree40');
  assert.equal(repetitions(restored), 20); assert.equal(task.repetition?.attempts, 40);
});

test('missing evidence, prose changes and cycling old effects consume allowance; reset does not forget history', () => {
  const task = { depth: 0 } as DurableTask;
  accountRepetition(task, 'a', 'b');
  accountRepetition(task, 'b', 'a');
  assert.equal(repetitions(task), 1);
  for (let i = 0; i < 19; i++) accountRepetition(task);
  assert.equal(repetitions(task), 20);
  task.repetition!.repetitions = 0;
  accountRepetition(task, 'a', 'b');
  assert.equal(repetitions(task), 1);
});

test('real pump runs 35 evidenced productive turns, then exactly 20 stagnant turns', async () => {
  let h: Harness; let tree = 0; let turns = 0;
  const runtime = new FakeRuntime(() => {
    turns++; if (turns <= 35) tree++;
    h.planContinuation('mem:room1', { state: 'continue', next: `same authorized approach ${turns}` });
    return 'done';
  });
  h = new Harness({ runtime, now: () => 1000, progressEvidence: async () => `tree${tree}`,
    completionCheck: async () => ({ state: 'continue', next: 'same authorized approach', progress: { advanced: false } }) });
  h.addChannel(new MemoryChannel());
  h.onStateChange = async () => {};
  await h.accept(msg('original authorized task')); await h.drained();
  const task = h.snapshotSessions()[0]!.tasks![0]!;
  assert.equal(turns, 55); assert.equal(task.state, 'blocked');
  assert.equal(task.depth, 54); assert.equal(repetitions(task), 20);
  await h.tick(); await h.drained(); assert.equal(turns, 55);
});
