import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConversationTranscript} from '../src/channels/transcript.js';
import type {TranscriptEntry} from '../src/channels/presentation.js';
for(const kind of ['assistant','user','info'] as const)test(`mutable entry cache ${kind}`,()=>{
 const transcript=new ConversationTranscript();const entry:TranscriptEntry={kind,text:'old value'};
 transcript.setEntries([entry],false);transcript.render(80);
 const before=(transcript as any).rows[0].component;
 entry.text='new value';transcript.setEntries([entry],false);
 assert.match(transcript.render(80).join('\n'),/new value/);
 assert.doesNotMatch(transcript.render(80).join('\n'),/old value/);
 const after=(transcript as any).rows[0].component;assert.notEqual(after,before);
 transcript.setEntries([entry],false);assert.equal((transcript as any).rows[0].component,after);
});
