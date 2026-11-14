import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkingMemory } from '../src/working-memory.js';
import { compactSkillCatalog, materializeSkillCatalog, localContextBudget, localModel } from '../src/local-context.js';
const policy=()=>({enabled:true,autoCapture:true,autoRecall:true});
const backend={recall:async()=>'',capture:async()=>{}};
async function home(t:any){const h=await mkdtemp(path.join(os.tmpdir(),'working-handover-'));t.after(()=>rm(h,{recursive:true,force:true}));return h;}

test('meaningful tool-free decision captured each turn, idempotently, bounded and scoped; no extra inference',async t=>{
 const h=await home(t);let calls=0;const memory=new WorkingMemory(h,{...backend,capture:async()=>{calls++;}},policy);
 const turn={sessionKey:'a',id:'one',text:'Slack release decision',reply:'Use the approved Slack release; deployment remains unverified',outcome:'completed' as const,tools:0};
 await memory.capture(turn);await memory.capture(turn);
 const files=await readdir(path.join(h,'working-memory'));assert.equal(files.length,1);
 const stored=JSON.parse(await readFile(path.join(h,'working-memory',files[0]!), 'utf8'));assert.equal(stored.entries.length,1);
 assert.match(await memory.recall('a','Slack'),/deployment remains unverified/);assert.equal(await memory.recall('foreign','Slack'),'');assert.equal(calls,2);
 for(let i=0;i<20;i++)await memory.capture({...turn,id:'id'+i,reply:'Slack report '+i+'x'.repeat(5000)});
 const bounded=await readFile(path.join(h,'working-memory',files[0]!), 'utf8');assert.ok(bounded.length<16000);assert.equal(JSON.parse(bounded).entries.length,8);
});
test('reset removes only own working handovers; disabled orchestration is respected dynamically',async t=>{
 const h=await home(t);let enabled=true;const memory=new WorkingMemory(h,backend,()=>({...policy(),enabled}));
 for(const key of ['a','b'])await memory.capture({sessionKey:key,text:'Slack',reply:'Slack decision',outcome:'completed'});
 await memory.reset('a');assert.equal(await memory.recall('a','Slack'),'');assert.match(await memory.recall('b','Slack'),/Slack decision/);
 enabled=false;assert.equal(await memory.recall('b','Slack'),'');await memory.capture({sessionKey:'a',text:'Slack',reply:'hidden',outcome:'completed'});enabled=true;assert.equal(await memory.recall('a','Slack'),'');
});
test('optional slow provider cannot hold a planning turn for minutes; outstanding recall remains bounded',async t=>{
 const h=await home(t);let active=0;const memory=new WorkingMemory(h,{capture:backend.capture,recall:async()=>{active++;return new Promise<string>(()=>{});}},policy);
 const start=Date.now();await Promise.all(Array.from({length:10},()=>memory.recall('a','Slack')));assert.equal(active,2);assert.ok(Date.now()-start<1500);
});
test('SDK-step capture never waits for a slow provider; a corrupt local file does not suppress long-term capture',async t=>{
 const h=await home(t);let captures=0;const memory=new WorkingMemory(h,{...backend,capture:async()=>{captures++;return new Promise<void>(()=>{});}},policy);
 const start=Date.now();await memory.captureWorking({sessionKey:'step',text:'Slack',reply:'Unverified Slack step',outcome:'completed'});
 assert.equal(captures,0);assert.ok(Date.now()-start<500);
 const files=await readdir(path.join(h,'working-memory'));const {writeFile}=await import('node:fs/promises');await writeFile(path.join(h,'working-memory',files[0]!),'{broken');
 const healthy=new WorkingMemory(h,{...backend,capture:async()=>{captures++;}},policy);await healthy.capture({sessionKey:'step',text:'Slack',reply:'Reported decision',outcome:'completed'});assert.equal(captures,1);
});

test('small explicit local budgets remain operator adjustable; frontier and physical model identity are not inferred',()=>{
 assert.equal(localModel({localModels:['local/exact']},'local/exact'),true);assert.equal(localModel({localModels:[]},'local/qwen'),false);
 assert.equal(localContextBudget(262144,false,true),16384);assert.equal(localContextBudget(131072,true,true),8192);
 assert.equal(localContextBudget(262144,false,true,{localMainContextTokens:32768}),32768);assert.equal(localContextBudget(4096,false,true),4096);
 assert.equal(localContextBudget(262144,false,false),262144);
});
test('content-addressed catalogs stay distinct and late entries are readable with actual SDK offset/limit',async t=>{
 const h=await home(t),skills=Array.from({length:100},(_,i)=>({name:'skill'+i,description:'large description'.repeat(1000),filePath:'/workspace/skills/'+i+'/SKILL.md',baseDir:'/workspace/skills/'+i}));
 const [first,second]=await Promise.all([materializeSkillCatalog(h,skills),materializeSkillCatalog(h,[{...skills[0]!,name:'other-runtime'}])]);assert.notEqual(first,second);
 const offset=(await readFile(first,'utf8')).split('\n').findIndex(line=>line.includes('"name": "skill99"'))+1;
 const {createReadTool}=await import('@earendil-works/pi-coding-agent');const read=createReadTool(h);const result=await read.execute('catalog-read',{path:first,offset,limit:4});
 assert.match(JSON.stringify(result),/skill99/);assert.match(JSON.stringify(result),/99\/SKILL.md/);assert.ok(!String(await readFile(first)).includes('other-runtime'));
});

test('default skill context is a small on-demand index, not every full description and duplicated path',()=>{
 const skills=Array.from({length:100},(_,i)=>({name:'skill'+i,description:'description'.repeat(1000),filePath:'/workspace/skills/'+i+'/SKILL.md',baseDir:'/workspace/skills/'+i}));
 const context=compactSkillCatalog(skills,'/private/skill-catalog.json');assert.ok(context.length<1600);assert.match(context,/100/);assert.match(context,/bounded offset\/limit/);assert.ok(!context.includes('descriptiondescription'));
});
