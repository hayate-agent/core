// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
const exec=promisify(execFile);

test('reasoning-only reviewer retries once with off without bypassing verdict parsing', async () => {
 const {runtimeReviewer}=await import('../src/runtime/reviewer.js');
 const calls: string[]=[];let disposed=0;
 const runtime={open:async()=>({prompt:async(_text:string,options:{thinking:string})=>{calls.push(options.thinking);return calls.length===1?'':'{"findings":[]}';},dispose:async()=>{disposed++;},abort:async()=>{}})};
 const result=await runtimeReviewer(runtime as never).review('review',undefined,'medium');
 assert.equal(result,'{"findings":[]}');assert.deepEqual(calls,['medium','off']);assert.equal(disposed,1);
});

for(const kind of ['throw','reject'])test(`review abort ${kind} is contained without losing prompt failure or cleanup`,async()=>{
 const moduleUrl=new URL('../src/runtime/reviewer.ts',import.meta.url).href;
 const code=`
 import {runtimeReviewer} from ${JSON.stringify(moduleUrl)};
 const controller=new AbortController();
 let release;const gate=new Promise(r=>release=r);
 let entered;const started=new Promise(r=>entered=r);
 let disposed=0;
 const session={prompt:async()=>{entered();await gate;throw Error('Review cancelled');},
 abort:${kind==='throw'?"()=>{throw Error('synthetic abort failure');}":"async()=>{throw Error('synthetic abort failure');}"},
 dispose:async()=>{disposed++;}};
 const result=runtimeReviewer({open:async()=>session}).review('synthetic',undefined,'off',controller.signal).catch(e=>e.message);
 await started;controller.abort();await new Promise(r=>setTimeout(r,20));release();
 if(await result!=='Review cancelled'||disposed!==1)throw Error('lost prompt failure or cleanup');
 console.log('ABORT_FAILURE_CONTAINED');`;
 const result=await exec(process.execPath,['--unhandled-rejections=strict','--import','tsx','--input-type=module','-e',code],{timeout:5000});
 assert.match(result.stdout,/ABORT_FAILURE_CONTAINED/);
});
