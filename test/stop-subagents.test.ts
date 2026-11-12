import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Harness} from '../src/harness.js';
import {Subagents,type SubagentHandover} from '../src/subagents.js';
import {FakeRuntime} from './fakes.js';
const handover:SubagentHandover={task:'test',context:'approved',constraints:'offline only',expectedResult:'evidence',acceptance:'tests',model:'p/m',thinking:'low'};
test('all managed children are saved cancelled before first abort; save failure cannot signal runtimes or accept late results',async()=>{
 const h=new Harness({runtime:new FakeRuntime(),tickMs:60000});h.paused=true;h.onStateChange=async()=>{};
 let fail=false;let saved:ReturnType<Subagents['snapshot']>=[];
 const manager=new Subagents(h,async()=>{if(fail)throw Error('save failed');saved=manager.snapshot();});h.addChannel(manager.channel);
 try{
  const first=await manager.start('parent',handover),second=await manager.start('parent',handover),other=await manager.start('other',handover);
  let aborts=0;
  const stop=h.stopConversation.bind(h);h.stopConversation=async key=>{aborts++;assert.ok(saved.filter(r=>r.parent==='parent').every(r=>r.state==='cancelled'));return stop(key);};
  fail=true;await assert.rejects(manager.cancelChildren('parent'),/save failed/);assert.equal(aborts,0);
  await manager.channel.send({channel:'subagents',target:first.id},'late evidence');assert.equal(manager.get('parent',first.id).state,'cancelled');
  fail=false;await manager.cancelChildren('parent');assert.equal(aborts,2);
  assert.equal(manager.get('parent',second.id).state,'cancelled');assert.equal(manager.get('other',other.id).state,'queued');
  const restored=new Subagents(h,async()=>{});restored.restore(saved);assert.throws(()=>restored.beforeTurn(first.sessionKey),/cancelled/);
 }finally{await manager.channel.stop?.();await h.stop(0);}
});
