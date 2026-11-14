import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Harness } from '../src/harness.js';
import { Scheduler, type CronJob } from '../src/scheduler.js';
import { FakeRuntime } from './fakes.js';

const own = { platform: 'matrix', chat_id: 'room', user_id: '@operator' };

test('/new pauses creator-bound cron jobs durably and stops their existing session; delivery-only and foreign schedules remain', async () => {
 let scheduler!: Scheduler; let saves = 0;
 const h = new Harness({ runtime: new FakeRuntime(), conversationSourcesReset: async (key, reset) => { await scheduler.resetConversation(key, reset); } });
 scheduler = new Scheduler(h, {});
 scheduler.jobs = [
  { name: 'owned', schedule: '0 * * * *', prompt: 'old job', origin: own },
  { name: 'foreign', schedule: '0 * * * *', origin: { ...own, chat_id: 'other' }, deliver: 'matrix:room' },
  { name: 'thread', schedule: '0 * * * *', origin: { ...own, thread_id: 'thread' } },
  { name: 'delivery-only', schedule: '0 * * * *', origin: { platform: 'matrix', chat_id: 'room' } },
 ];
 h.onStateChange = async () => { saves++; };
 h.restoreSessions([{ key: 'cron:owned', tasks: [{ id: 'occurrence', original: 'old job', state: 'waiting', depth: 0 }] },
  { key: 'cron:foreign', tasks: [{ id: 'foreign', original: 'foreign', state: 'active', depth: 0 }] }]);
 await h.resetSession('matrix:room');
 assert.equal(scheduler.overrides.get('owned'), false); assert.ok(saves > 0);
 for (const name of ['foreign', 'thread', 'delivery-only']) assert.equal(scheduler.overrides.has(name), false);
 assert.equal(h.state('cron:owned').tasks![0].state, 'stopped');
 assert.equal(h.state('cron:foreign').tasks![0].state, 'active');
 await scheduler.runJob(scheduler.jobs[0]); assert.equal(h.pendingInputs().length, 0);
 await h.stop(0);
});

test('reset aborts and drains creator-owned script before it can deliver or enqueue an old occurrence', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'origin-cron-')); const scripts = path.join(home, 'scripts'); await mkdir(scripts);
 const started = path.join(home, 'started');
 await writeFile(path.join(scripts, 'waiting.sh'), '#!/bin/sh\necho started > "'+started+'"\nexec sleep 60\n', { mode: 0o700 });
 const h = new Harness({ runtime: new FakeRuntime() }); h.onStateChange = async () => {};
 const scheduler = new Scheduler(h, { scriptsDir: scripts });
 const job: CronJob = { name: 'owned-script', schedule: '0 * * * *', script: 'waiting.sh', prompt: 'must not enqueue', origin: own };
 scheduler.jobs = [job];
 let finished = false; const running = scheduler.runJob(job).catch(() => {}).finally(() => { finished = true; });
 try {
  for (let i = 0; i < 100; i++) { try { await access(started); break; } catch { await new Promise(r => setTimeout(r, 5)); } }
  await access(started); await scheduler.resetConversation('matrix:room');
  assert.ok(finished); await running; assert.equal(h.pendingInputs().length, 0);
 } finally { scheduler.stop(); await running; await h.stop(0); await rm(home, { recursive: true, force: true }); }
});

test('ambiguous same-name foreign provenance fails closed before pausing an unrelated schedule', async () => {
 const h = new Harness({ runtime: new FakeRuntime() }); const scheduler = new Scheduler(h, {});
 scheduler.jobs = [{ name: 'duplicate', schedule: '* * * * *', origin: own },
  { name: 'duplicate', schedule: '* * * * *', origin: { ...own, chat_id: 'other' } }];
 await assert.rejects(scheduler.resetConversation('matrix:room'), /Ambiguous/);
 assert.equal(scheduler.overrides.size, 0); await h.stop(0);
});


test('ambiguous source preflight leaves main state unchanged and does not open fresh context', async () => {
 let scheduler!: Scheduler; const runtime = new FakeRuntime();
 const h = new Harness({ runtime, conversationSourcesReset: async (key, reset) => { await scheduler.resetConversation(key, reset); } });
 scheduler = new Scheduler(h, {}); h.onStateChange = async () => {};
 scheduler.jobs = [{ name: 'collision', schedule: '* * * * *', origin: own },
   { name: 'collision', schedule: '* * * * *', origin: { ...own, chat_id: 'foreign' } }];
 h.restoreSessions([{ key: 'matrix:room', tasks: [{ id: 'old', original: 'old work', state: 'active', depth: 0 }] }]);
 const before = JSON.stringify(h.snapshotSessions());
 await assert.rejects(h.resetSession('matrix:room'), /Ambiguous/);
 assert.equal(JSON.stringify(h.snapshotSessions()), before); assert.equal(runtime.opened.length, 0);
 assert.equal(scheduler.overrides.size, 0); await h.stop(0);
});


test('cron name remains fenced through recursive source reset and releases after failure', async () => {
 const h = new Harness({ runtime: new FakeRuntime() }); h.onStateChange = async () => {};
 const scheduler = new Scheduler(h, {}); scheduler.jobs = [{ name: 'owned', schedule: '* * * * *', origin: own }];
 await assert.rejects(scheduler.resetConversation('matrix:room', async sources => {
  assert.deepEqual(await sources(), ['cron:owned']);
  await assert.rejects(scheduler.load(), /reset in progress/);
  assert.throws(() => scheduler.setEnabled('owned', true), /reset in progress/);
  await scheduler.runJob({ name: 'owned', schedule: '* * * * *', origin: { ...own, chat_id: 'foreign' }, prompt: 'must not enqueue' }, true);
  assert.equal(h.pendingInputs().length, 0);
  throw Error('recursive reset failed');
 }), /recursive reset failed/);
 assert.equal(scheduler.overrides.get('owned'), false);
 assert.doesNotThrow(() => scheduler.setEnabled('owned', true));
 await h.stop(0);
});


test('preflight lease prevents reload-away during parent stop and drains the original script and source', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'origin-stop-race-')); const scripts = path.join(home, 'scripts'); await mkdir(scripts);
 const started = path.join(home, 'started'); const jobsFile = path.join(home, 'jobs.yaml');
 await writeFile(path.join(scripts, 'wait.sh'), '#!/bin/sh\necho ready > "'+started+'"\nexec sleep 60\n', { mode: 0o700 });
 await writeFile(jobsFile, 'jobs:\n- name: owned\n  schedule: "0 * * * *"\n  origin: {platform: matrix, chat_id: foreign, user_id: operator}\n');
 let scheduler!: Scheduler; let entered = false, release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const h = new Harness({ runtime: new FakeRuntime(),
  conversationSourcesReset: async (key, reset) => { await scheduler.resetConversation(key, reset); },
  conversationStopping: async key => { if (key === 'matrix:room') { entered = true; await gate; } } });
 h.onStateChange = async () => {};
 scheduler = new Scheduler(h, { scriptsDir: scripts, jobsFile });
 scheduler.jobs = [{ name: 'owned', schedule: '* * * * *', origin: own, script: 'wait.sh', prompt: 'must not enqueue' }];
 h.restoreSessions([{ key: 'cron:owned', tasks: [{ id: 'old-occurrence', state: 'active', original: 'owned', depth: 0 }] }]);
 let drained = false; const running = scheduler.runJob(scheduler.jobs[0]).catch(() => {}).finally(() => { drained = true; });
 try {
  for (let i=0;i<100;i++) { try { await access(started); break; } catch { await new Promise(r=>setTimeout(r,5)); } }
  await access(started); const resetting = h.resetSession('matrix:room');
  for (let i=0;i<100&&!entered;i++) await new Promise(r=>setTimeout(r,5)); assert.ok(entered);
  await assert.rejects(scheduler.load(), /reset in progress/);
  assert.equal(scheduler.jobs[0].origin?.chat_id, 'room');
  release(); await resetting; await running;
  assert.ok(drained); assert.equal(h.state('cron:owned').tasks![0].state, 'stopped');
  assert.equal(h.pendingInputs().length, 0);
 } finally { release(); scheduler.stop(); await running; await h.stop(0); await rm(home,{recursive:true,force:true}); }
});


test('reset source plan survives crash even when its cron definition is removed before restart', async () => {
 let scheduler!: Scheduler; const h = new Harness({ runtime: new FakeRuntime(),
  conversationSourcesReset: async (key, reset) => { await scheduler.resetConversation(key, reset); },
  conversationStopping: async key => { if (key === 'matrix:room') throw Error('crash after parent marker'); } });
 h.onStateChange = async () => {}; scheduler = new Scheduler(h, {});
 scheduler.jobs = [{ name: 'owned', schedule: '* * * * *', origin: own }];
 h.restoreSessions([{ key: 'cron:owned', tasks: [{ id: 'old', original: 'owned', state: 'active', depth: 0 }] }]);
 await assert.rejects(h.resetSession('matrix:room'), /crash/);
 assert.deepEqual(h.state('matrix:room').resetSources, ['cron:owned']);
 let recoveredScheduler!: Scheduler; const recovered = new Harness({ runtime: new FakeRuntime(),
  conversationSourcesReset: async (key, reset) => { await recoveredScheduler.resetConversation(key, reset); } });
 recovered.onStateChange = async () => {}; recoveredScheduler = new Scheduler(recovered, {});
 recovered.restoreSessions(h.snapshotSessions()); recoveredScheduler.jobs = [];
 await recovered.resetSession('matrix:room');
 assert.equal(recovered.state('cron:owned').tasks![0].state, 'stopped');
 assert.equal(recovered.state('matrix:room').resetSources, undefined);
 await h.stop(0); await recovered.stop(0);
});


test('removed definition cannot orphan an active creator-bound occurrence during reset', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'origin-removed-')); const scripts = path.join(home, 'scripts'); await mkdir(scripts);
 const started = path.join(home, 'started'); const jobsFile = path.join(home, 'jobs.yaml');
 await writeFile(jobsFile, 'jobs: []\n');
 await writeFile(path.join(scripts, 'wait.sh'), '#!/bin/sh\necho ready > "'+started+'"\nexec sleep 60\n', { mode: 0o700 });
 let scheduler!: Scheduler;
 const h = new Harness({ runtime: new FakeRuntime(), conversationSourcesReset: async (key, reset) => { await scheduler.resetConversation(key, reset); } });
 h.onStateChange = async () => {}; scheduler = new Scheduler(h, { scriptsDir: scripts, jobsFile });
 scheduler.jobs = [{ name: 'removed', schedule: '* * * * *', origin: own, script: 'wait.sh', prompt: 'must not revive' }];
 h.restoreSessions([{ key: 'cron:removed', tasks: [{ id: 'old', state: 'active', original: 'removed', depth: 0 }] }]);
 let drained = false; const running = scheduler.runJob(scheduler.jobs[0]).catch(() => {}).finally(() => { drained = true; });
 try {
  for(let i=0;i<100;i++){try{await access(started);break;}catch{await new Promise(r=>setTimeout(r,5));}}
  await access(started); await scheduler.load(); assert.equal(scheduler.jobs.length, 0);
  await h.resetSession('matrix:room'); await running; assert.ok(drained);
  assert.equal(h.state('cron:removed').tasks![0].state, 'stopped');
  assert.equal(h.pendingInputs().length, 0); assert.equal(scheduler.overrides.get('removed'), false);
 } finally { scheduler.stop(); await running; await h.stop(0); await rm(home,{recursive:true,force:true}); }
});

test('persisted source names are checked against foreign replacement before retry mutation', async () => {
 let scheduler!: Scheduler; const runtime = new FakeRuntime();
 const h = new Harness({ runtime, conversationSourcesReset: async (key, reset) => { await scheduler.resetConversation(key, reset); } });
 h.onStateChange = async () => {}; scheduler = new Scheduler(h, {});
 h.restoreSessions([{ key: 'matrix:room', resetPending: true, stopPending: true, resetSources: ['cron:reused'] },
  { key: 'cron:reused', tasks: [{ id: 'foreign', original: 'foreign', state: 'active', depth: 0 }] }]);
 scheduler.jobs = [{ name: 'reused', schedule: '* * * * *', origin: { ...own, chat_id: 'foreign' } }];
 const before = JSON.stringify(h.snapshotSessions());
 await assert.rejects(h.resetSession('matrix:room'), /Ambiguous/);
 assert.equal(JSON.stringify(h.snapshotSessions()), before); assert.equal(runtime.opened.length, 0);
 assert.equal(h.state('cron:reused').tasks![0].state, 'active'); await h.stop(0);
});


test('creator-to-cron ownership remains durable after enqueue, definition removal and restart', async () => {
 let scheduler!: Scheduler; const h = new Harness({ runtime: new FakeRuntime(),
  conversationSourcesReset: async (key, reset) => { await scheduler.resetConversation(key, reset); } });
 h.onStateChange = async () => {}; scheduler = new Scheduler(h, {});
 const job: CronJob = { name: 'finished-admission', schedule: '* * * * *', origin: own, prompt: 'retained job work' };
 scheduler.jobs = [job]; await scheduler.runJob(job);
 await new Promise(resolve => setImmediate(resolve));
 const source = h.state('cron:finished-admission');
 assert.equal(source.sourceOwner, 'matrix:room');
 source.tasks = [{ id: 'unfinished', original: 'retained job work', state: 'waiting', depth: 0 }]; source.task = undefined;
 let restoredScheduler!: Scheduler; const restored = new Harness({ runtime: new FakeRuntime(),
  conversationSourcesReset: async (key, reset) => { await restoredScheduler.resetConversation(key, reset); } });
 restored.onStateChange = async () => {}; restored.restoreSessions(h.snapshotSessions());
 restoredScheduler = new Scheduler(restored, {}); restoredScheduler.jobs = [];
 await restored.resetSession('matrix:room');
 assert.equal(restored.state('cron:finished-admission').tasks![0].state, 'stopped');
 assert.equal(restoredScheduler.overrides.get('finished-admission'), false);
 await h.stop(0); await restored.stop(0);
});


test('empty source plan still leases reload during parent stop, including earlier in-flight reads', async () => {
 const home=await mkdtemp(path.join(os.tmpdir(),'origin-empty-')); const file=path.join(home,'jobs.yaml');
 await writeFile(file, 'jobs:\n- name: new-owned\n  schedule: "0 * * * *"\n  origin: {platform: matrix, chat_id: room, user_id: operator}\n');
 let scheduler!:Scheduler, entered=false, release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
 const h=new Harness({runtime:new FakeRuntime(), conversationSourcesReset:async(key,reset)=>{await scheduler.resetConversation(key,reset);},
  conversationStopping:async key=>{if(key==='matrix:room'){entered=true;await gate;}}});
 h.onStateChange=async()=>{}; scheduler=new Scheduler(h,{jobsFile:file});
 try{
  const pending=h.resetSession('matrix:room');
  for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,5)); assert.ok(entered);
  await assert.rejects(scheduler.load(),/reset in progress/);assert.equal(scheduler.jobs.length,0);
  release();await pending;
  const reading=assert.rejects(scheduler.load(),/reset in progress or changed/);
  await h.resetSession('matrix:other');await reading;assert.equal(scheduler.jobs.length,0);
 }finally{release();scheduler.stop();await h.stop(0);await rm(home,{recursive:true,force:true});}
});
