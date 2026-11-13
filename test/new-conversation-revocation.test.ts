import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness.js';
import { ExecutionStore } from '../src/execution.js';
import { Dispatcher, stopDispatcherParent } from '../src/dispatcher.js';
import { executionControlRequest } from '../src/execution-control.js';
import { toolGuardDenialReason } from '../src/tool-guard-error.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';

const wait = async (condition: () => boolean) => {
 for (let i = 0; i < 200 && !condition(); i++) await new Promise(r => setTimeout(r, 5));
 assert.ok(condition());
};

test('/new drains parent and running child, fences late effects, and preserves another gateway conversation', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'new-revocation-'));
 const store = new ExecutionStore(path.join(home, 'executions.json')); await store.load();
 const runtime = new FakeRuntime(); const channel = new MemoryChannel();
 let childAborted = false, entered = false, release!: (value: string) => void;
 const dispatcher = new Dispatcher(store, { name: 'test', version: 1, replaySafe: false,
   execute: async (_task, ctx) => { await new Promise<void>(resolve => { ctx.signal.addEventListener('abort', () => { childAborted = true; resolve(); }, { once: true }); }); return 'must not publish late result'; } }, 1, async () => {});
 const h = new Harness({ runtime, executionStore: store,
   conversationStopped: key => stopDispatcherParent(store, key, dispatcher),
   completionCheck: async () => ({ state: 'continue', next: 'MUST NOT RESUME OLD WORK' }) });
 h.addChannel(channel); h.onStateChange = async () => {};
 const open = runtime.open.bind(runtime);
 runtime.open = async (key, options) => {
  if (options?.fresh) assert.equal(h.state(key).running, false, 'fresh context must not overlap old prompt');
  const s = await open(key, options);
  if (!options?.fresh) {
   s.prompt = async () => { entered = true; return new Promise<string>(resolve => { release = resolve; }); };
   s.abort = async () => { release('late old reply'); };
  }
  return s;
 };
 try {
  const child = await store.submit('mem:room1', 'owned', 'owned work', 'test');
  const other = await store.submit('matrix:other-room', 'other', 'unrelated', 'test');
  await store.control(other.id, 'pause');
  const otherBefore = store.list(other.parent);
  await dispatcher.start(); await wait(() => store.list('mem:room1')[0].status === 'running');
  await h.submit(msg('old main task')); await wait(() => entered);
  h.state('mem:room1').loop = { prompt: 'old recurring', everyMs: 10, nextAt: 0, paused: false };
  await h.resetSession('mem:room1');
  assert.ok(childAborted);
  assert.equal(store.list('mem:room1')[0].status, 'cancelled');
  assert.deepEqual(store.list(other.parent), otherBefore);
  assert.ok(h.state('mem:room1').tasks?.every(t => t.state === 'stopped'));
  assert.equal(h.state('mem:room1').loop, undefined);
  assert.equal(h.state('mem:room1').lastInput, undefined);
  assert.ok(!channel.texts().some(t => /late old reply|must not publish/.test(t)));
  await h.tick(Date.now() + 60000); await h.recoverTasks();
  assert.equal(h.pendingInputs().filter(i => i.sessionKey === 'mem:room1').length, 0);
  assert.equal(store.list('mem:room1').find(x => x.id === child.id)!.result, undefined);
 } finally { await dispatcher.stop(); await h.stop(100); await rm(home, { recursive: true, force: true }); }
});

test('failed child revocation preserves durable reset marker; retry/restart finishes reset without resuming old work', async () => {
 const runtime = new FakeRuntime(); let fail = true;
 const h = new Harness({ runtime, conversationStopping: async () => { if (fail) throw Error('private failure'); } });
 h.onStateChange = async () => {};
 h.restoreSessions([{ key: 'mem:room1', tasks: [{ id: 'old', original: 'old mandate', state: 'waiting', depth: 0,
  next: 'old next', wait: { nextAt: 0, deadline: Date.now() + 60000, reason: 'old wait' } }] }]);
 await h.sessionFor('mem:room1'); h.state('mem:room1').running = true;
 await assert.rejects(h.resetSession('mem:room1'), /private failure/);
 assert.equal(h.state('mem:room1').resetPending, true);
 assert.equal(h.state('mem:room1').stopPending, true);
 assert.ok(runtime.opened.every(x => !x.fresh));
 await assert.rejects(h.accept(msg('must not enter failed reset')), /reset in progress/);
 await assert.rejects(h.submit(msg('must not queue after failed reset')), /reset in progress/);
 fail = false;
 await h.stopConversation('mem:room1');
 assert.equal(h.state('mem:room1').resetPending, true);
 assert.equal(h.state('mem:room1').stopPending, true);
 await assert.rejects(h.guardWaitTool('mem:room1', 'bash', {}), e => toolGuardDenialReason(e).startsWith('execution_cancelled:'));
 const restored = new Harness({ runtime: new FakeRuntime() }); restored.onStateChange = async () => {};
 restored.restoreSessions(h.snapshotSessions());
 fail = false;
 await restored.resetSession('mem:room1');
 assert.equal(restored.state('mem:room1').resetPending, undefined);
 assert.equal(restored.state('mem:room1').tasks![0].state, 'stopped');
 await restored.recoverTasks(); assert.equal(restored.pendingInputs().length, 0);
 h.state('mem:room1').running = false;
 await h.stop(0); await restored.stop(0);
});

test('operator reset invokes only exact parent scope, with no task creation or permission to reset a worker', async () => {
 const parents: string[] = [];
 const dispatcher = {} as Dispatcher;
 await executionControlRequest(dispatcher, { op: 'reset-conversation', parent: 'matrix:room' }, async parent => { parents.push(parent); });
 assert.deepEqual(parents, ['matrix:room']);
 for (const frame of [{ op: 'reset-conversation', parent: 'dispatch:worker' }, { op: 'reset-conversation', parent: 'matrix:room', extra: true }])
  await assert.rejects(executionControlRequest(dispatcher, frame, async parent => { parents.push(parent); }));
 assert.deepEqual(parents, ['matrix:room']);
});
