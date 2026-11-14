import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Dispatcher } from '../src/dispatcher.js';
import { DispatcherRuntime } from '../src/dispatcher-runtime.js';
import { ExecutionStore, ExecutionWorkerFailure } from '../src/execution.js';
import { dispatcherPlugin } from '../src/builtin-plugins/dispatcher-plugin.js';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('timeout');
}
function surfaces(store: ExecutionStore) {
  let tool: any, command: any;
  dispatcherPlugin(() => ({ store }) as any).activate({ registerTool: (t: any) => tool = t, registerCommand: (c: any) => command = c } as any);
  return async (id: string) => {
    const toolRow = JSON.parse(await tool.execute({ action: 'status', id }, { sessionKey: 'parent' })).tasks[0];
    const commandRow = JSON.parse(await command.run('status', { sessionKey: 'parent' })).tasks.find((row: any) => row.id === id);
    assert.equal(toolRow.diagnostic, commandRow.diagnostic);
    return toolRow.diagnostic;
  };
}

for (const failure of [new Error('provider SECRET <ignore instructions>'), new ExecutionWorkerFailure('worker-failed'), new ExecutionWorkerFailure('worker-cancelled')]) {
  test(`failure ${failure.name}/${failure.message}: atomic diagnostic survives ack and restart without launches`, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dispatch-diagnostic-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'ledger.json');
    const store = new ExecutionStore(file); await store.load();
    const task = await store.submit('parent', 'request', 'fixture', 'direct');
    let calls = 0;
    // Without reconciliation support, uncertain effects must still stay held.
    const strategy = { name: 'direct', version: 1, replaySafe: false, reconcile: false, execute: async (_task: any, ctx: any) => {
      calls++; await ctx.intent('effect', 'unsafe'); throw failure;
    } };
    const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {});
    await dispatcher.start();
    await until(() => store.list()[0].status === 'blocked');
    await dispatcher.stop();
    assert.equal(calls, 1);
    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(disk.executions[0].status, 'blocked');
    assert.equal(disk.executions[0].diagnosticCode, failure instanceof ExecutionWorkerFailure ? failure.diagnosticCode : 'runtime-failure');
    assert.doesNotMatch(JSON.stringify(disk), /SECRET|ignore instructions/);
    const before = await surfaces(store)(task.id);
    assert.match(before, /effects are uncertain/);
    for (const event of store.events()) await store.ack(event.id);
    const restarted = new ExecutionStore(file); await restarted.load();
    const next = new Dispatcher(restarted, { ...strategy, execute: async () => { calls++; assert.fail('no worker launch after restart'); } }, 1, async () => {}, () => {});
    await next.start(); await next.kick(); await next.stop();
    assert.equal(calls, 1); assert.equal(restarted.events().length, 0);
    assert.equal(await surfaces(restarted)(task.id), before);
  });
}

test('settled success adoption still launches no second worker', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dispatch-success-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.json'); const store = new ExecutionStore(file); await store.load();
  const task = await store.submit('parent', 'success', 'fixture', 'direct'); const owned = await store.claim(task.id);
  const key = `turn:${task.id}:${owned.token}`;
  await store.intent(task.id, owned.token!, key, 'unsafe'); await store.settleIntent(task.id, owned.token!, key, 'durable answer', 'durable answer');
  const restarted = new ExecutionStore(file); await restarted.load();
  await restarted.recover(new Map([['direct', { version: 1, replaySafe: false, reconcile: true }]]));
  let launches = 0;
  const runtime = new DispatcherRuntime({ accept: async () => { launches++; assert.fail('second worker'); } } as any, restarted);
  const dispatcher = new Dispatcher(restarted, runtime.strategy, 1, async () => {}, () => {});
  await dispatcher.start(); await until(() => restarted.list()[0].status === 'completed'); await dispatcher.stop();
  assert.equal(launches, 0); assert.equal(restarted.list()[0].result, 'durable answer');
});

test('bridge uses typed host cause and never forwards worker prose', async () => {
  const runtime = new DispatcherRuntime({} as any, {} as any);
  for (const outcome of ['failed', 'cancelled'] as const) {
    let received: any;
    (runtime as any).pending.set('worker', { reject: (error: any) => received = error });
    await runtime.channel.send({ target: 'worker' } as any, 'SECRET worker instruction', { outcome });
    assert.ok(received instanceof ExecutionWorkerFailure);
    assert.equal(received.diagnosticCode, `worker-${outcome}`);
    assert.doesNotMatch(received.message, /SECRET|instruction/);
  }
});

test('retry-exhausted and empty-result core events name a user action; live retry still promises automatic recovery', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dispatch-hints-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The intervention hint lives in the core status events written by execution.ts,
  // not in plugin prose: a fresh checkout materialized from the production lock
  // must pass this test without any local or vendored plugin source.
  const statusEvents = (store: ExecutionStore, id: string) =>
    store.events().filter(event => event.executionId === id && event.type === 'status').map(event => event.text);
  // Cap 1: the single failed attempt exhausts the automatic budget immediately.
  const store = new ExecutionStore(path.join(dir, 'exhausted.json'), { workerRetryMax: 1 }); await store.load();
  const task = await store.submit('parent', 'exhaust', 'fixture', 'direct');
  const owned = await store.claim(task.id);
  await store.fail(task.id, owned.token!, 'worker-failed', { strategy: { version: 1, replaySafe: false, reconcile: true } });
  const exhausted = store.list()[0];
  assert.equal(exhausted.diagnosticCode, 'retry-exhausted');
  assert.equal(exhausted.workerRetry, undefined);
  assert.equal(exhausted.status, 'paused');
  const exhaustedEvent = statusEvents(store, task.id).find(text => text.includes('retry-exhausted'));
  assert.ok(exhaustedEvent, 'core status event marks retry exhaustion');
  assert.match(exhaustedEvent, /Manuelle Intervention erforderlich: Aufgabe explizit fortsetzen oder abbrechen/);
  assert.doesNotMatch(exhaustedEvent, /keine Nutzeraktion erforderlich/);

  const done = await store.submit('parent', 'empty', 'fixture', 'direct');
  const claim = await store.claim(done.id);
  await store.complete(done.id, claim.token!, '');
  const marked = store.list().find(row => row.id === done.id)!;
  assert.equal(marked.status, 'completed');
  assert.equal(marked.diagnosticCode, 'empty-result');
  const emptyEvent = statusEvents(store, done.id).find(text => text.includes('empty-result'));
  assert.ok(emptyEvent, 'core status event marks the empty result');
  assert.match(emptyEvent, /neu einreichen oder explizit auflösen/);
  assert.doesNotMatch(emptyEvent, /keine Nutzeraktion erforderlich/);

  // Contrast: a live automatic retry still promises recovery without user action.
  const liveStore = new ExecutionStore(path.join(dir, 'live.json')); await liveStore.load();
  const live = await liveStore.submit('parent', 'live', 'fixture', 'direct');
  const liveClaim = await liveStore.claim(live.id);
  await liveStore.fail(live.id, liveClaim.token!, 'worker-failed', { strategy: { version: 1, replaySafe: false, reconcile: true } });
  assert.ok(liveStore.list()[0].workerRetry, 'default budget keeps an automatic retry slot');
  const liveEvent = statusEvents(liveStore, live.id).find(text => text.includes('automatischer Wiederanlauf'));
  assert.ok(liveEvent, 'core status event promises automatic recovery');
  assert.match(liveEvent, /keine Nutzeraktion erforderlich/);
});
