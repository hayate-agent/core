import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Harness} from '../src/harness.js';
import {ExecutionStore} from '../src/execution.js';
import {Dispatcher} from '../src/dispatcher.js';
import {FakeRuntime, MemoryChannel, msg} from './fakes.js';

for (const fail of [false,true]) test(`stop persistence precedes all aborts, save failure=${fail}`,async()=>{
 const runtime=new FakeRuntime();const order:string[]=[];
 const h=new Harness({runtime,tickMs:60000,conversationStopping:async()=>{order.push('children-saved');}});
 h.onStateChange=async()=>{};h.addChannel(new MemoryChannel());
 try {
  const session=await h.sessionFor('mem:room1');runtime.sessions.get('mem:room1')!.hold();
  await h.submit(msg('work'));await new Promise<void>(r=>setImmediate(r));
  const abort=session.abort.bind(session);session.abort=async()=>{order.push('abort');await abort();};
  h.onStateChange=async()=>{order.push('save');assert.equal(h.pendingInputs().length,0);if(fail)throw Error('disk unavailable');};
  if(fail){await assert.rejects(h.stopConversation('mem:room1'),/disk unavailable/);assert.deepEqual(order,['save']);h.onStateChange=async()=>{order.push('retry-save');};}
  await h.stopConversation('mem:room1');await h.drained();
  assert.deepEqual(order.slice(0,fail?4:3),fail?['save','retry-save','children-saved','abort']:['save','children-saved','abort']);
 }finally{h.onStateChange=async()=>{};await h.stop(1000);}
});

test('crash after persisted stop before abort retains history but not timers, inbox or child authority',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'stop-durable-'));const file=path.join(home,'ledger.json');
 const store=new ExecutionStore(file);await store.load();
 const active=await store.submit('parent','active','original child','fake');const claim=await store.claim(active.id);
 await store.checkpoint(active.id,claim.token!,'retained evidence');
 await store.submit('parent','queued','queued child','fake');const other=await store.submit('other','ready','other work','fake');
 const h=new Harness({runtime:new FakeRuntime(),tickMs:60000,conversationStopping:key=>store.cancelParent(key),conversationStopped:async()=>{throw Error('simulated crash before abort');}});
 h.paused=true;
 h.restoreSessions([{key:'parent',task:{id:'original-task',original:'original mandate',state:'waiting',depth:1,next:'check source',anchor:{id:'anchor',task:'original mandate',receivedAt:1},wait:{reason:'external dependency',nextAt:1000,deadline:900000}}}]);
 let snapshot=h.snapshotSessions();let pending=h.pendingInputs();
 h.onStateChange=async()=>{snapshot=structuredClone(h.snapshotSessions());pending=structuredClone(h.pendingInputs());};
 try{
  await h.submit({id:'queued-parent',source:'api',sessionKey:'parent',text:'queued'});
  await assert.rejects(h.stopConversation('parent'),/simulated crash/);
  assert.equal(snapshot.find(s=>s.key==='parent')?.stopPending,true);
  await assert.rejects(store.complete(active.id,claim.token!,'late result'));
  await assert.rejects(store.checkpoint(active.id,claim.token!,'late checkpoint'));
  const reload=new ExecutionStore(file);await reload.load();
  assert.ok(reload.list('parent').every(t=>t.parentStopped && t.status==='cancelled'));
  assert.equal(reload.list('parent')[0]?.checkpoint,'retained evidence');
  assert.equal(reload.list().find(t=>t.id===other.id)?.status,'ready');
  const runtime=new FakeRuntime();const restored=new Harness({runtime,tickMs:60000,now:()=>61000});restored.onStateChange=async()=>{};
  restored.restoreSessions(snapshot);restored.restorePending(pending);
  await restored.tick();await restored.drained();
  assert.equal(runtime.opened.length,0);assert.equal(pending.length,0);
  assert.equal(restored.state('parent').task?.state,'stopped');assert.equal(restored.state('parent').task?.anchor?.id,'anchor');
  assert.equal(restored.state('parent').task?.original,'original mandate');await restored.stop(0);
 }finally{await h.stop(0);await rm(home,{recursive:true,force:true});}
});

test('pending claim revoked before strategy admission never starts',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'stop-claim-'));const store=new ExecutionStore(path.join(home,'ledger.json'));await store.load();let calls=0;
 const d=new Dispatcher(store,{name:'fake',version:1,replaySafe:true,execute:async()=>{calls++;return 'bad';}},1,async()=>{},()=>{});
 const claim=store.claim.bind(store);store.claim=async(...args)=>{const result=await claim(...args);await store.cancelParent('parent');return result;};
 try{await d.start();await d.submit('parent','request','work');assert.equal(calls,0);assert.equal(store.list()[0]?.status,'cancelled');}
 finally{await d.stop();await rm(home,{recursive:true,force:true});}
});
