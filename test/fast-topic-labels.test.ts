import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedTopicInput, fastTopicLabeler, topicModelChain } from '../src/topic-labels.js';
import { validateModelRoles } from '../src/model-roles.js';

const valid='{"topic":null,"inherit":false,"tags":["local-performance"]}';
test('explicit hashtag model or Main only, legacy roles never silently select metadata',()=>{
 const roles={enabled:true,roles:{hashtag:{model:'local/small'},dispatcher:{model:'local/dispatch'},reviewer:{model:'cloud/large'}}};
 validateModelRoles(roles);assert.deepEqual(topicModelChain(roles,'local/main'),['local/main']);
 assert.deepEqual(topicModelChain(roles,'local/main','local/explicit'),['local/explicit']);
 assert.deepEqual(topicModelChain({...roles,roles:{hashtag:{model:'local/main'},dispatcher:{model:'local/main'}}},'local/main'),['local/main']);
 assert.deepEqual(topicModelChain({enabled:false,roles:roles.roles},'local/main'),['local/main']);
 assert.deepEqual(topicModelChain(undefined,undefined),[undefined]);
});
test('failed/malformed candidates fall through in order; successful tags cached; business input never sent for execution',async()=>{
 const calls:string[]=[];const label=fastTopicLabeler({review:async(prompt,model,thinking)=>{
 calls.push(model!);assert.equal(thinking,'off');assert.match(prompt,/tool-free metadata classifier/);
 return model==='local/main'?valid:'malformed';}},()=>['local/small','local/dispatch','local/main']);
 assert.deepEqual(await label('Improve local performance',[]),['local-performance']);
 assert.deepEqual(await label('Improve local performance',[]),['local-performance']);
 assert.deepEqual(calls,['local/small','local/dispatch','local/main']);
});
test('timeouts abort each model and never block incoming user work for minutes',async()=>{
 const aborted:string[]=[];const started=Date.now();const label=fastTopicLabeler({review:async(_p,m,_t,signal)=>new Promise((_resolve,reject)=>{
 signal?.addEventListener('abort',()=>{aborted.push(m!);reject(Error('aborted'));},{once:true});
 })},()=>['small','dispatch','main'],undefined,10);
 assert.deepEqual(await label('hello',[]),['topic-clarification']);assert.deepEqual(aborted,['small','dispatch','main']);assert.ok(Date.now()-started<500);
});
test('trusted plugin service v1 overrides classifier; bounded data/no cached stale implementation',async()=>{
 let tags=['plugin-label'];let called=0;const label=fastTopicLabeler({review:async()=>{throw Error('must not call model');}},()=>['main'],{get:()=>({version:1,implementation:{label:async(text:string,candidates:unknown[],recent:unknown[],signal:AbortSignal)=>{
 called++;assert.ok(text.length<=1600);assert.ok(signal instanceof AbortSignal);return tags;
 }}})});
 assert.deepEqual(await label('x'.repeat(5000),[]),['plugin-label']);tags=['new-provider'];assert.deepEqual(await label('x'.repeat(5000),[]),['new-provider']);assert.equal(called,2);
});
test('plugin failure falls back to exact chain; no unknown provider or output exposed',async()=>{
 const label=fastTopicLabeler({review:async()=>valid},()=>['main'],{get:()=>({version:1,implementation:{label:async()=>{throw Error('private provider failure');}}})});
 assert.deepEqual(await label('test',[]),['local-performance']);
});
test('classifier context stays small and does not inherit hidden bundles',()=>{
 const data=boundedTopicInput('x'.repeat(100000),Array.from({length:100},(_,i)=>({id:'topic-'+i,text:'x'.repeat(100000),tags:Array.from({length:20},(_,j)=>'topic-'+i+'-'+j)})),Array.from({length:50},()=>({role:'assistant' as const,text:'r'.repeat(100000)})));
 assert.ok(JSON.stringify(data).length<=3000);assert.ok(data.candidates.length<=16);assert.ok(data.recent.length<=8);
 // The tighter total budget may omit a large candidate bundle; never inherit it implicitly.
 const hidden=boundedTopicInput('new',[{id:'oversized',text:'topic',tags:Array(25).fill('prior-tag')}],[]);assert.deepEqual(hidden.candidates,[]);
});


test('legacy ambiguity is a non-decision: next configured model can resolve it; exhaustion stays neutral and uncached',async()=>{
 let calls=0;const label=fastTopicLabeler({review:async(_p,m)=>{calls++;return m==='small'?' {"ambiguous":true}':valid;}},()=>['small','dispatch','main']);
 assert.deepEqual(await label('context?',[]),['local-performance']);assert.equal(calls,2);
 let unavailable=0;const exhausted=fastTopicLabeler({review:async()=>{unavailable++;return '{"ambiguous":true}';}},()=>['small','dispatch','main']);
 assert.deepEqual(await exhausted('context?',[]),['topic-clarification']);assert.deepEqual(await exhausted('context?',[]),['topic-clarification']);assert.equal(unavailable,6);
});
