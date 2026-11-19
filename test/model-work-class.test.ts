import test from'node:test';import assert from'node:assert/strict';import{localModelWorkHeaders,modelWorkClass}from'../src/model-work-class.js';
test('human gateway/local requests versus machine/delegated/maintenance, no authority inferred',()=>{
 for(const k of['matrix:room','webui:conversation','slack:room','local-fixture','console:local'])assert.equal(modelWorkClass(k),'interactive');
 for(const k of['dispatch:one:claim','subagent:one','cron:job','api:paperclip:issue','api:operator-unknown','unregistered'])assert.equal(modelWorkClass(k),'background');
 assert.equal(modelWorkClass('matrix:room',true),'background');
});
test('local-only headers preserve auth and explicit background; canonical casing and model switches',()=>{
 const h:Record<string,string|null>={Authorization:'unchanged-fixture','x-hayate-model-work':'interactive'};localModelWorkHeaders(h,'matrix:room',true);assert.equal(h.Authorization,'unchanged-fixture');assert.equal(h['X-Hayate-Model-Work'],'interactive');assert.equal(h['x-hayate-model-work'],undefined);
 localModelWorkHeaders(h,'matrix:room',true,true);assert.equal(h['X-Hayate-Model-Work'],'background');const off={Authorization:'unchanged'};localModelWorkHeaders(off,'matrix:room',false);assert.deepEqual(off,{Authorization:'unchanged'});
 const summary={'x-Hayate-model-work':'background'};localModelWorkHeaders(summary,'matrix:room',true);assert.equal((summary as any)['X-Hayate-Model-Work'],'background');
});
