import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness.js';
import { ExecutionStore } from '../src/execution.js';
import { StateStore } from '../src/state.js';
import { FakeRuntime, MemoryChannel, msg } from './fakes.js';
import type { Inbound } from '../src/types.js';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
async function fixture(t: test.TestContext, options: Partial<ConstructorParameters<typeof Harness>[0]> = {}, storeFactory = (file: string) => new ExecutionStore(file)) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'foreground-preparation-'));
  const store = storeFactory(path.join(home, 'executions.json')); await store.load();
  const runtime = new FakeRuntime(t => `answer: ${t}`), channel = new MemoryChannel(), state = new StateStore(path.join(home, 'state.json'));
  const releases: Array<() => void> = [];
  const h = new Harness({ runtime, executionStore: store, busyMode: 'queue', tickMs: 60000,
    completionCheck: async () => ({ state: 'completed' }), ...options });
  h.addChannel(channel);
  const persist = () => state.capture(() => ({ version: 1, paused: h.paused, busyMode: h.busyMode,
    sessions: h.snapshotSessions(false), pending: h.pendingInputs(), outbox: h.outboxEntries(), seen: h.seenIds() }));
  h.onStateChange = persist;
  t.after(async () => { for (const release of releases) release(); await h.stop(1000); await persist(); await rm(home, { recursive: true, force: true }); });
  return { h, runtime, channel, state, store, persist, releases };
}
const background = (): Inbound => ({ id: 'original-background', executionTurnId: 'same-background-turn', sessionKey: 'mem:room1', source: 'cron', text: 'original background step', replyTo: { channel: 'mem', target: 'room1' } });

for (const source of ['channel', 'api'] as const) test(`${source} accepted during background beforeTurn runs first; original step/hook run once`, { timeout: 5000 }, async t => {
  const entered = gate(), release = gate(); let preparations = 0;
  const f = await fixture(t, { taskLifecycle: { enabled: true }, beforeTurn: async input => { if (input.id === 'original-background') { preparations++; entered.resolve(); await release.promise; } } });
  f.releases.push(release.resolve);
  await f.h.submit(background()); await entered.promise;
  const originalRef = f.h.pendingInputs().find(i => i.id === 'original-background')!.taskRef;
  assert(originalRef);
  const input = { ...msg('human question'), id: 'human', source };
  await f.h.accept(input);
  release.resolve(); await f.h.drained();
  const session = f.runtime.sessions.get('mem:room1')!;
  assert.deepEqual(session.prompts, ['human question', 'original background step']);
  assert.equal(preparations, 1, 'completed beforeTurn hook is retained across preparation yield');
  assert.equal(session.aborted, 0); assert.deepEqual(session.steered, []);
  assert.equal(f.h.pendingInputs().length, 0);
  const retained = f.h.state('mem:room1').tasks?.find(t => t.id === 'original-background')!;
  assert.equal(retained.state, 'completed'); assert.deepEqual(retained.taskRef, originalRef);
  assert.equal(f.store.coreTask(originalRef.id)?.generation, originalRef.generation);
});

test('foreground accepted while durable background beginTurn is pending wins before native inference', { timeout: 5000 }, async t => {
  const entered = gate(), release = gate(); let first = true;
  class HeldBeginStore extends ExecutionStore {
    override async beginTurn(...args: Parameters<ExecutionStore['beginTurn']>) {
      const result = await super.beginTurn(...args);
      if (first) { first = false; entered.resolve(); await release.promise; }
      return result;
    }
  }
  const f = await fixture(t, {}, file => new HeldBeginStore(file)); f.releases.push(release.resolve);
  await f.h.submit(background()); await entered.promise;
  await f.h.accept({ ...msg('human question'), id: 'human' });
  release.resolve(); await f.h.drained();
  assert.deepEqual(f.runtime.sessions.get('mem:room1')!.prompts, ['human question', 'original background step']);
  assert.equal(f.h.pendingInputs().length, 0);
});

test('uncommitted foreground inbox never acquires inference priority or bypasses its save barrier', { timeout: 5000 }, async t => {
  const entered = gate(), release = gate(), saveEntered = gate(), saveRelease = gate(), backgroundRan = gate();
  const f = await fixture(t, { beforeTurn: async input => { if (input.id === 'original-background') { entered.resolve(); await release.promise; } } });
  f.releases.push(release.resolve, saveRelease.resolve);
  const answer = f.runtime.answer; f.runtime.answer = (text, key) => { if (text === 'original background step') backgroundRan.resolve(); return answer(text, key); };
  f.h.onStateChange = async () => { if (f.h.pendingInputs().some(i => i.id === 'human') && !f.h.state('mem:room1').tasks?.some(t => t.id === 'human')) { saveEntered.resolve(); await saveRelease.promise; } await f.persist(); };
  await f.h.submit(background()); await entered.promise;
  const accepting = f.h.accept({ ...msg('human question'), id: 'human' }); await saveEntered.promise;
  release.resolve(); await backgroundRan.promise;
  assert.deepEqual(f.runtime.sessions.get('mem:room1')!.prompts, ['original background step']);
  saveRelease.resolve(); await accepting; await f.h.drained();
  assert.deepEqual(f.runtime.sessions.get('mem:room1')!.prompts, ['original background step', 'human question']);
});

test('already running background inference is neither aborted nor replayed to serve queued foreground', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.h.sessionFor('mem:room1');
  const session = f.runtime.sessions.get('mem:room1')!, release = session.hold(), entered = gate(); f.releases.push(release);
  const prompt = session.prompt.bind(session); session.prompt = async (...args) => { entered.resolve(); return prompt(...args); };
  await f.h.submit(background()); await entered.promise;
  await f.h.accept({ ...msg('human question'), id: 'human' });
  assert.deepEqual(session.prompts, ['original background step']); assert.equal(session.aborted, 0);
  release(); await f.h.drained();
  assert.deepEqual(session.prompts, ['original background step']);
  assert.deepEqual(session.steered, ['human question'], 'existing active-turn steering remains unchanged');
  assert.equal(session.aborted, 0); assert.equal(f.h.pendingInputs().length, 0);
});

for (const kind of ['startup-assessment', 'blocked-child-assessment'] as const)
test(`settled answer is durably delivered before unrelated ${kind}; supervision still precedes next prompt`, { timeout: 7000 }, async t => {
  const entered = gate(), release = gate(); let assessments = 0;
  const f = await fixture(t, { completionCheck: async input => { if (input.taskId === 'retained') { assessments++; entered.resolve(); await release.promise; return { state: 'blocked' }; } return { state: 'completed' }; } });
  f.releases.push(release.resolve);
  if (kind === 'blocked-child-assessment') {
    const child = await f.store.submit('mem:room1', 'old-child', 'old held mandate', 'fixture', 1, { taskId: 'retained', original: 'old held mandate', depth: 0 });
    const claim = await f.store.claim(child.id); await f.store.fail(child.id, claim.token!, 'runtime-failure');
  }
  const children = JSON.stringify(f.store.list());
  f.h.restoreSessions([{ key: 'mem:room1', replyTo: { channel: 'mem', target: 'room1' },
    task: { id: 'retained', original: 'old held mandate', state: kind === 'startup-assessment' ? 'active' : 'waiting', depth: 0, recoveryEnrollment: 'current' } }]);
  const send = f.channel.send.bind(f.channel);
  f.channel.send = async (to, text, meta) => {
    const saved = await f.state.load();
    assert(saved?.outbox?.some(entry => entry.id === meta?.deliveryId && entry.text === text), 'stable final reply is already in the durable host outbox');
    assert(!saved.pending?.some(i => i.id === 'human'), 'settled input already left the durable inbox');
    return send(to, text, meta);
  };
  await f.h.accept({ ...msg('human question'), id: 'human' }); await entered.promise;
  assert.deepEqual(f.channel.texts(), ['answer: human question'], 'another mandate supervisor cannot delay this answer');
  assert.equal(assessments, 1);
  await f.h.accept({ ...msg('second human question'), id: 'second' });
  assert.deepEqual(f.runtime.sessions.get('mem:room1')!.prompts, ['human question'], 'supervision is not starved by continuous foreground');
  release.resolve(); await f.h.drained();
  assert.deepEqual(f.runtime.sessions.get('mem:room1')!.prompts, ['human question', 'second human question']);
  assert.equal(JSON.stringify(f.store.list()), children, 'blocked child ownership/uncertain effects remain untouched');
});

for (const queuedHuman of [false, true]) test(`durable own continuation preserves supervision and foreground priority (new question=${queuedHuman})`, { timeout: 7000 }, async t => {
  const entered = gate(), release = gate(); let continuationRuns = 0;
  const f = await fixture(t, { completionCheck: async input => {
    if (input.taskId === 'retained') { entered.resolve(); await release.promise; return { state: 'blocked' }; }
    return input.continuation?.state === 'continue' ? { state: 'continue', next: 'finish original work' } : { state: 'completed' };
  } });
  f.releases.push(release.resolve);
  f.runtime.answer = text => {
    if (text === 'human question') f.h.planContinuation('mem:room1', { state: 'continue', next: 'finish original work' });
    else { if (text.includes('finish original work')) continuationRuns++; f.h.planContinuation('mem:room1', { state: 'completed' }); }
    return `answer: ${text}`;
  };
  f.h.restoreSessions([{ key: 'mem:room1', task: { id: 'retained', original: 'old independent mandate', state: 'active', depth: 0, recoveryEnrollment: 'current' } }]);
  await f.h.accept({ ...msg('human question'), id: 'human' }); await entered.promise;
  assert.deepEqual(f.channel.texts(), ['answer: human question']);
  const checkpoint = await f.state.load();
  assert.equal(checkpoint?.pending?.filter(i => i.taskId === 'human').length, 1, 'admitted next step shares the completion checkpoint');
  assert.equal(continuationRuns, 0, 'read-only retained supervision still happens before productive continuation');
  if (queuedHuman) await f.h.accept({ ...msg('second question'), id: 'second' });
  release.resolve(); await f.h.drained();
  const prompts = f.runtime.sessions.get('mem:room1')!.prompts;
  assert.equal(prompts[0], 'human question');
  if (queuedHuman) assert.equal(prompts[1], 'second question');
  assert.equal(prompts.length, queuedHuman ? 3 : 2); assert.equal(continuationRuns, 1);
  const retained = f.h.state('mem:room1').tasks?.find(t => t.id === 'retained')!;
  assert.equal(retained.state, queuedHuman ? 'active' : 'blocked', 'new foreground invalidates an in-flight startup verdict');
  assert.equal(retained.recoveryAdmission, undefined);
});

test('failed final host checkpoint still withholds delivery; retry sends stable reply without another model call', { timeout: 5000 }, async t => {
  const f = await fixture(t); let failed = false, failSave = true;
  f.h.onStateChange = async () => { if (failSave && f.h.outboxEntries().length) { failed = true; throw Error('injected final checkpoint failure'); } await f.persist(); };
  await f.h.accept({ ...msg('human question'), id: 'human' }); await f.h.waitForSessionIdle('mem:room1');
  assert.equal(failed, true); assert.deepEqual(f.channel.texts(), []);
  const id = f.h.outboxEntries()[0]!.id;
  failSave = false;
  await f.h.tick(); await f.h.drained();
  assert.deepEqual(f.channel.texts(), ['answer: human question']); assert.equal(f.channel.sent[0]!.meta?.deliveryId, id);
  assert.deepEqual(f.runtime.sessions.get('mem:room1')!.prompts, ['human question']);
});

test('transient early delivery failure is one attempt per pump, stable retry, no model/effect replay', { timeout: 5000 }, async t => {
  const f = await fixture(t), send = f.channel.send.bind(f.channel); let attempts = 0; const ids: Array<string | undefined> = [];
  f.channel.send = async (to, text, meta) => { ids.push(meta?.deliveryId); if (++attempts === 1) throw Error('transient transport failure'); await send(to, text, meta); };
  await f.h.accept({ ...msg('human question'), id: 'human' }); await f.h.waitForSessionIdle('mem:room1');
  assert.equal(attempts, 1); assert.equal(f.h.outboxEntries().length, 1);
  await f.h.tick(); await f.h.drained();
  assert.equal(attempts, 2); assert.equal(ids[0], ids[1]); assert.deepEqual(f.channel.texts(), ['answer: human question']);
  assert.deepEqual(f.runtime.sessions.get('mem:room1')!.prompts, ['human question']);
});
