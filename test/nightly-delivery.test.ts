import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nightly from '../src/builtin-plugins/nightly-default.js';
import {experimentReceipts,improvementReport} from '../src/builtin-plugins/improvement-report.js';
import {ImprovementController} from '../src/improvement.js';
import {Harness} from '../src/harness.js';
import {FakeRuntime} from './fakes.js';
import type {ExperimentReceipt} from '../src/improvement-receipt.js';

const base:ExperimentReceipt={execution:'performed',hypothesis:'delivery fixture',baseline:'old measured',candidate:'new tested',evidence:'regression passed',outcome:'improved'};
const pushed:ExperimentReceipt={...base,delivery:{stream:'upstream',status:'pushed',repository:'https://git.vanillacore.net/harness/core',commit:'a'.repeat(40),branch:'fix/fixture',pullRequest:'https://git.vanillacore.net/harness/core/pulls/1'}};
const block=(r:unknown)=>'```improvement-experiment\n'+JSON.stringify(r)+'\n```';

function progress(experiments:ExperimentReceipt[]=[],deliveryBacklog:ExperimentReceipt[]=[]){return {experiments,deliveryBacklog,recentHypotheses:experiments.map(x=>x.hypothesis),noExperimentTurns:0,done:false,results:[] as string[]};}

test('two delivery streams, existing authority and actual activation are explicit in prompt',()=>{
 const text=nightly.prompt({enabled:true,startHour:23,endHour:5,maxTurns:20,timezone:'UTC'},1);
 for(const value of ['Upstream-Quellrepo','Skill-/Instanz-/Konfigurationsrepo','committen','pushen','Push ist keine Integration','Keine neuen Credentials'])assert.ok(text.includes(value));
});

test('structured publication receipt roundtrips; malformed claims remain unverified local evidence',()=>{
 assert.deepEqual(experimentReceipts(block(pushed)),[pushed]);
 for(const delivery of [{...pushed.delivery,commit:'invented'},{...pushed.delivery,commit:undefined},{...pushed.delivery,status:'deployed'},{...pushed.delivery,status:'blocked'},{...pushed.delivery,status:'magic'}])
  assert.equal(experimentReceipts(block({...base,delivery}))[0].delivery,undefined);
});

test('local improvement cannot close successfully; delivery update is not a new experiment',()=>{
 const p=progress();nightly.completed(p,block(base)+'\n[IMPROVEMENT_DONE]');assert.equal(p.done,false);assert.equal(p.experiments.length,1);
 nightly.completed(p,block(pushed)+'\n[IMPROVEMENT_DONE]');assert.equal(p.done,true);assert.equal(p.experiments.length,1);assert.equal(p.noExperimentTurns,0);assert.deepEqual(p.experiments[0].delivery,pushed.delivery);
});

test('delivery backlog updates without counting old experiments; no status regression or candidate substitution',()=>{
 const p=progress([], [structuredClone(pushed)]);nightly.completed(p,block({...pushed,delivery:{...pushed.delivery,status:'integrated'}}));assert.equal(p.experiments.length,0);assert.equal(p.deliveryBacklog[0].delivery?.status,'integrated');
 nightly.completed(p,block(pushed));assert.equal(p.deliveryBacklog[0].delivery?.status,'integrated');
 nightly.completed(p,block({...pushed,candidate:'different untested candidate'}));assert.equal(p.deliveryBacklog[0].candidate,base.candidate);
});

test('morning report separates local, pushed, blocked and deployment evidence, without inventing activation',()=>{
 const r=improvementReport({night:'2026-11-12',turns:1,deliveryBacklog:[pushed]},'UTC',[base,pushed],'/local/artifact.json');
 assert.match(r,/Remote-Übergabe und Bereitstellung unbelegt/);assert.match(r,/upstream \/ pushed/);assert.match(r,/keine neuen Experimente dieser Nacht/);assert.doesNotMatch(r,/Aktivierungsbeleg:/);
});

test('next night retains delivery backlog and prioritizes it without resetting original night or replaying effects',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'nightly-delivery-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(path.join(home,'improvement'));
 await writeFile(path.join(home,'improvement/state.json'),JSON.stringify({version:1,night:'2026-11-12',turns:20,done:true,reportQueued:true,results:[],experiments:[base],recentHypotheses:[base.hypothesis]}));
 const harness=new Harness({runtime:new FakeRuntime(),tickMs:60000});t.after(()=>harness.stop(1000));let text='';harness.enqueue=input=>{text=input.text;};
 const c=new ImprovementController(home,harness,'UTC',()=>Date.parse('2026-11-13T23:30Z'),nightly);await c.tick(true);
 const s=JSON.parse(await readFile(path.join(home,'improvement/state.json'),'utf8'));assert.equal(s.night,'2026-11-13');assert.equal(s.experiments.length,0);assert.equal(s.deliveryBacklog.length,1);assert.equal(s.turns,0);assert.match(text,/Offene Auslieferung zuerst/);assert.match(text,/delivery fixture/);
});

test('legacy archived improvements are imported once as backlog, not experiments or authority',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'nightly-delivery-history-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(path.join(home,'improvement/reports'),{recursive:true});
 await writeFile(path.join(home,'improvement/state.json'),JSON.stringify({version:1,night:'2026-11-12',turns:0,results:[],experiments:[],recentHypotheses:[]}));
 await writeFile(path.join(home,'improvement/reports/2026-11-11.json'),JSON.stringify({version:1,night:'2026-11-11',experiments:[base]}));
 await writeFile(path.join(home,'improvement/reports/2026-11-10.json'),'{broken archive');
 const harness=new Harness({runtime:new FakeRuntime(),tickMs:60000});t.after(()=>harness.stop(1000));harness.enqueue=()=>{};
 const c=new ImprovementController(home,harness,'UTC',()=>Date.parse('2026-11-12T23:30Z'),nightly);await c.tick(true);
 const s=JSON.parse(await readFile(path.join(home,'improvement/state.json'),'utf8'));assert.equal(s.turns,0);assert.equal(s.experiments.length,0);assert.equal(s.deliveryHistoryImported,true);assert.equal(s.deliveryBacklog.length,1);assert.deepEqual(s.deliveryBacklog[0],base);assert.deepEqual(s.deliveryImportIssues,['2026-11-10.json']);
});

test('late delegated delivery updates retained evidence without a new turn or reopening the night',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'nightly-delivery-late-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(path.join(home,'improvement'));
 await writeFile(path.join(home,'improvement/state.json'),JSON.stringify({version:1,night:'2026-11-12',turns:1,done:true,results:[],experiments:[base],recentHypotheses:[base.hypothesis],noExperimentTurns:2}));
 const harness=new Harness({runtime:new FakeRuntime(),tickMs:60000});t.after(()=>harness.stop(1000));
 const task={id:'delivery-child',parent:'improvement:nightly',status:'completed',result:block(pushed),dependency:{taskId:'improvement:2026-11-12:1'}} as import('../src/execution.js').Execution;
 const c=new ImprovementController(home,harness,'UTC',()=>Date.parse('2026-11-13T12:00Z'),nightly,undefined,()=>[task]);await c.delegatedResult(task.id);
 const s=JSON.parse(await readFile(path.join(home,'improvement/state.json'),'utf8'));assert.equal(s.turns,1);assert.equal(s.done,true);assert.equal(s.experiments.length,1);assert.equal(s.experiments[0].delivery.status,'pushed');assert.equal(s.noExperimentTurns,0);
});

test('host closure cannot approve improved local-only work even if reviewer would say completed',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'nightly-delivery-closure-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(path.join(home,'improvement'));
 const id='improvement:2026-11-12:1';await writeFile(path.join(home,'improvement/state.json'),JSON.stringify({version:1,night:'2026-11-12',turns:0,pending:id,results:[],experiments:[],recentHypotheses:[]}));
 const harness=new Harness({runtime:new FakeRuntime(),tickMs:60000});t.after(()=>harness.stop(1000));let calls=0;const c=new ImprovementController(home,harness,'UTC',()=>Date.parse('2026-11-12T23:30Z'),nightly,async()=>{calls++;return {state:'completed'};});
 const input={id,sessionKey:'improvement:nightly',source:'cron' as const,text:'original authorized mandate'};await c.before(input);await c.completed(input,block(base)+'\n[IMPROVEMENT_DONE]');
 const s=JSON.parse(await readFile(path.join(home,'improvement/state.json'),'utf8'));assert.equal(s.done,false);assert.equal(calls,0);assert.match(s.closureFeedback,/Auslieferung offen/);assert.equal(s.turns,1);
});
