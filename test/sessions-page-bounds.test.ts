import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COMMANDS,type CommandContext} from '../src/commands.js';
import {Harness} from '../src/harness.js';
import {FakeRuntime,msg} from './fakes.js';
const maxPage=Math.floor(Number.MAX_SAFE_INTEGER/20)+1;
for(const page of [1,2,maxPage,maxPage+1,Number.MAX_SAFE_INTEGER,2**53])test(`session page ${page}`,async()=>{
 const offsets:number[]=[];
 const runtime=Object.assign(new FakeRuntime(),{sessions:async(_key:string,offset:number)=>{offsets.push(offset);return [];}});
 const harness=new Harness({runtime,log:()=>{}});
 const result=await COMMANDS.find(c=>c.name==='sessions')!.run(String(page),msg('/sessions'),{harness} as CommandContext);
 if(page<=maxPage){assert.equal(result,'No sessions on this page.');assert.deepEqual(offsets,[(page-1)*20]);}
 else {assert.equal(result,'usage: /sessions [page]');assert.deepEqual(offsets,[]);}
});
