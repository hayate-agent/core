import assert from 'node:assert/strict';
import {test} from 'node:test';
import {COMMANDS,type CommandContext} from '../src/commands.js';
import {Harness} from '../src/harness.js';
import {FakeRuntime,msg} from './fakes.js';
const command=COMMANDS.find(c=>c.name==='hashtags')!;
for(const failing of [false,true])test(`hashtag command local cache, failing=${failing}`,async()=>{
 let reads=0;
 const runtime=Object.assign(new FakeRuntime(),{sessionHistory:async()=>{reads++;if(failing)throw Error('offline');return [{id:'a',role:'user',text:'first'},{id:'b',role:'user',text:'second'}];}});
 const harness=new Harness({runtime,log:()=>{}});
 harness.state('mem:room1').hashtags=[{tag:'alpha',sessionId:'old',messageId:'a',date:'1'},{tag:'alpha',sessionId:'old',messageId:'b',date:'2'},...(!failing?[{tag:'alpha',sessionId:'other',messageId:'a',date:'3'}]:[])];
 const ctx={harness} as CommandContext;
 const expected=failing?'1 · old · unavailable: offline\n2 · old · unavailable: offline':'1 · old\n  first\n  /resume old\n2 · old\n  second\n  /resume old\n3 · other\n  first\n  /resume other';
 for(let invocation=1;invocation<=2;invocation++){
  assert.equal(await command.run('#alpha',msg('/hashtags #alpha'),ctx),expected);
  console.log(JSON.stringify({failing,invocation,reads}));
  assert.equal(reads,invocation*2);
 }
});
