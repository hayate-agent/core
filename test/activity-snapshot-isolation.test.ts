import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TurnActivity} from '../src/activity.js';
test('consumer mutations cannot modify tracked tool evidence',()=>{
 const activity=new TurnActivity({id:'synthetic',role:'main',context:'operator'},()=>{},{enabled:false});
 activity.event({type:'tool',phase:'start',callId:'call',name:'read'});
 const first=activity.snapshot();const original=first.tools[0].callId;
 first.tools[0].name='changed';first.tools[0].callId='changed';
 assert.deepEqual(activity.snapshot().tools,[{callId:original,name:'read'}]);
 activity.finish('completed');
});
test('consumer mutations cannot modify host tags',()=>{
 const activity=new TurnActivity({id:'synthetic',role:'main',context:'operator',outputTags:['alpha']},()=>{},{enabled:false});
 activity.snapshot().outputTags!.push('changed');
 assert.deepEqual(activity.snapshot().outputTags,['alpha']);
 activity.finish('completed');
});
