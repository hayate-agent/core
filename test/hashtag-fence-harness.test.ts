import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Harness} from '../src/harness.js';
import {FakeRuntime,MemoryChannel,msg} from './fakes.js';

test('fenced hashtags do not load history through actual Harness admission',async()=>{
 const runtime=new FakeRuntime();let reads=0;
 const harness=new Harness({runtime:Object.assign(runtime,{sessionHistory:async()=>{reads++;return [{id:'a',role:'user',text:'#alpha old decision'}];}}),tickMs:60000,log:()=>{}});
 harness.addChannel(new MemoryChannel());await harness.start();
 harness.state('mem:room1').hashtags=[{tag:'alpha',sessionId:'old',messageId:'a',date:'1'}];
 try{
  for(const text of ['```\n```js\n#alpha\n```','````\n```\n#alpha\n````']){
   await harness.submit(msg(text));await harness.drained();
   assert.doesNotMatch(runtime.sessions.get('mem:room1')!.options.at(-1)!.instructions??'',/Selected hashtag history/);
  }
  assert.equal(reads,0);
  await harness.submit(msg('```\n#hidden\n````\n#alpha next'));await harness.drained();
  assert.equal(reads,1);
  assert.match(runtime.sessions.get('mem:room1')!.options.at(-1)!.instructions??'',/old decision/);
  assert.equal(runtime.opened.length,1);
 }finally{await harness.stop();}
});
