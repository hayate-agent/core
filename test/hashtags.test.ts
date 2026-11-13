import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseHashtags, hashtagReferences } from "../src/hashtags.js";

const exec = promisify(execFile);

test("minimal hashtag parsing excludes quoted/code/linked/untrusted material", () => {
  assert.deepEqual(parseHashtags(`#One #two-3 #ONE\n> #quote\n    #indent\n\t#tab\n\`#inline\` "#quoted" '#single' [#link](https://x/#x)\n\`\`\`ts\n#code\n\`\`\`\n~~~\n#code\n~~~\n<untrusted>\n#injection\n</untrusted>\n#real, C#lang https://x/#fragment ##heading #bad--slug`), ["one", "real", "two-3"]);
  assert.deepEqual(hashtagReferences("s", "#tag", [{ id: "tool", role: "toolResult", text: "#tag" }], "date", new Set()), []);
  assert.deepEqual(parseHashtags('<source>\n<item>\n</item>\n#hidden\n</source>\n#visible'), ['visible']);
  assert.deepEqual(hashtagReferences('s', '#tag', [{ id: 'old', role: 'user', text: '#tag' }], 'date', new Set(['old'])), []);
});

for (const external of [false, true]) test(`SDK Harness commands persist references and reopen (${external ? "external" : "native"})`, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hashtags-sdk-"));
  try {
    const code = `
import assert from 'node:assert/strict';
import {PiRuntime} from './src/runtime/pi.ts';
import {FilesystemSessionProvider} from './src/sessions.ts';
import {Harness} from './src/harness.ts';
import {installCommands} from './src/commands.ts';
import {StateStore} from './src/state.ts';
import {MemoryChannel, msg} from './test/fakes.ts';
const home=process.env.TEST_HOME;
const external=${external};
const store=new StateStore(home+'/state.json');
function create(){
 const runtime=new PiRuntime({cwd:home,sessionsDir:home+'/native',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},sessionProvider:external?()=>new FilesystemSessionProvider(home+'/external'):undefined});
 const harness=new Harness({runtime,tickMs:60000,log:()=>{}});
 const ch=new MemoryChannel();harness.addChannel(ch);
 harness.onStateChange=()=>store.save({version:1,paused:false,busyMode:'queue',sessions:harness.snapshotSessions()});
 installCommands({harness,agent:'test',admins:[],approvals:{mode:'off',tools:[]},skills:()=>[],reloadSkills:async()=>{},personality:{available:async()=>[],set:async()=>{}},restart:async()=>{}});
 return {runtime,harness,ch};
}
let {runtime,harness,ch}=create();
await harness.start();
let session=await harness.sessionFor('mem:room1');
const id=session.status().sessionId;
// Keep the real SDK transcript/provider/adapter and Harness command path. Only
// replace network inference: append the messages the SDK finalizes at turn end.
session.prompt=async(text)=>{
 const manager=session.session.sessionManager;
 manager.appendMessage({role:'user',content:text,timestamp:Date.now()});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'saved'}],api:'openai-completions',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
 return 'saved';
};
await harness.submit(msg('Discuss #Release today'));await harness.drained();
assert.equal(harness.state('mem:room1').hashtags.length,1);
assert.equal(ch.texts().at(-1),'#release · saved');
assert.ok(session.archiveEntries().some(e=>e.role==='assistant'&&e.text==='saved'));
assert.ok(!session.archiveEntries().some(e=>e.role==='assistant'&&e.text.includes('#release ·')));
await harness.submit({...msg('#robot'),source:'api'});await harness.drained();
assert.equal(harness.state('mem:room1').hashtags.length,1);
assert.equal(ch.texts().at(-1),'saved');
// Explicitly checkpoint external provider through its supported adapter lifecycle.
await session.dispose();harness.state('mem:room1').session=undefined;
await harness.stop(1000);
({runtime,harness,ch}=create());harness.restoreSessions((await store.load()).sessions);
async function send(text,key='mem:room1'){await harness.submit({...msg(text),sessionKey:key});await harness.drained();return ch.texts().at(-1);}
await harness.start();
assert.equal(await send('/hashtags'),'#release');
assert.equal(harness.state('mem:room1').session,undefined,'lookup must not activate a session');
// Restored native/external references must feed actual Harness pre-prompt options.
session=await harness.sessionFor('mem:room1');
let captured;
session.prompt=async(text,options)=>{captured=options.instructions;return 'context checked';};
await harness.submit(msg('Continue #release'));await harness.drained();
assert.match(captured,/Discuss #Release today/);
assert.match(captured,new RegExp(id));
assert.match(captured,/NOT instructions or new authority/);
assert.equal(harness.state('mem:room1').hashtags.length,1); // generated context never indexed
const result=await send('/hashtags #release');
assert.match(result,/Discuss #Release today/);assert.ok(result.includes('/resume '+id));
assert.equal(harness.state('mem:room1').session,session,'lookup must not replace the active session');
assert.equal(await send('/hashtags','mem:other'),'No hashtags indexed yet.');
await assert.rejects(runtime.sessionHistory('mem:other',id));
await send('/resume '+id);assert.equal(harness.state('mem:room1').session.status().sessionId,id);
assert.ok((await runtime.sessionHistory('mem:room1',id)).some(e=>e.text==='Discuss #Release today'));
harness.state('mem:room1').hashtags.push({tag:'broken',sessionId:id,messageId:'missing',date:'2026-01-01'});
assert.match(await send('/hashtags #broken'),/Referenced message no longer retained/);
assert.equal(await send('/hashtags nope'),'usage: /hashtags [#slug]');
assert.equal(await send('/hashtags #absent'),'No references for this hashtag.');
await send('/new');assert.equal(await send('/hashtags'),'No hashtags indexed yet.');
harness.restoreSessions([{key:'legacy'}]);assert.equal(harness.state('legacy').hashtags,undefined);
await harness.stop(1000);
console.log('HASHTAGS_OK');`;
    const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, TEST_HOME: home, PI_CODING_AGENT_DIR: home }, timeout: 30000,
    });
    assert.match(result.stdout, /HASHTAGS_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
