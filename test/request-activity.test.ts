import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RequestActivity} from '../scripts/request-activity.mjs';

test('a model progressing longer than 90 seconds is not timed out',()=>{
 let now=0;const activity=new RequestActivity('own',()=>now);
 for(let i=0;i<30;i++){
  now+=10000;activity.frame({choices:[{delta:{reasoning_content:'progress'}}]});
  assert.equal(activity.inactive(90000),false);
 }
 assert.equal(activity.snapshot().elapsedMs,300000);assert.equal(activity.snapshot().events,30);
});

test('queue or prefill before first own progress stays unknown, not a dead model',()=>{
 let now=0;const activity=new RequestActivity('own',()=>now);activity.headers(200);
 now=300000;activity.transport();activity.frame({choices:[{delta:{role:'assistant'}}]});
 assert.equal(activity.inactive(90000),false);
 assert.equal(activity.snapshot().modelInactiveMs,null);
 assert.equal(activity.snapshot().state,'waiting-or-prefill-unknown');
});

test('only own model deltas reset inactivity; keepalives, role-only and empty frames do not',()=>{
 let now=0;const activity=new RequestActivity('own',()=>now);
 activity.frame({choices:[{delta:{tool_calls:[{function:{name:'read',arguments:'{"path":'}}]}}]});
 now=80000;activity.frame({choices:[{token_ids:[12,13],delta:{}}]});
 now=160000;activity.transport();activity.headers(200);activity.frame({choices:[{delta:{}}]});
 assert.equal(activity.inactive(90000),false);
 now=170001;assert.equal(activity.inactive(90000),true);
 assert.equal(activity.inactive(undefined),false,'no invented default inactivity policy');
 activity.finish();assert.equal(activity.inactive(90000),false);
});

test('finished request timings stay frozen when later model requests run',()=>{
 let now=0;const activity=new RequestActivity('first',()=>now);
 now=60000;activity.frame({choices:[{delta:{content:'done'}}]});activity.finish();
 now=138000;activity.finish();assert.equal(activity.snapshot().elapsedMs,60000);
 assert.equal(activity.snapshot().modelInactiveMs,0);
});
