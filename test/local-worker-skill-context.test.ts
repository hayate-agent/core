import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from'node:fs/promises';
import os from'node:os';import path from'node:path';
import {PiRuntime}from'../src/runtime/pi.js';
import {ModelRuntime}from'@earendil-works/pi-coding-agent';

test('real SDK worktree skill discovery stays usable but local prompts page metadata, reload and frontier restore',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'worker-skills-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const cwd=path.join(home,'primary'),worker=path.join(home,'worktree'),skills=path.join(home,'skills');await mkdir(cwd);await mkdir(worker);
 for(let i=0;i<30;i++){const dir=path.join(skills,'fixture-'+i);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'SKILL.md'),`---\nname: fixture-${i}\ndescription: ${'Unique worker skill metadata '.repeat(15)}\n---\nPrivate fixture body ${i}\n`);}
 const models=await ModelRuntime.create();models.registerProvider('skill-fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:['local','frontier'].map(id=>({id,name:id,api:'openai-completions',reasoning:false,input:['text'],contextWindow:131072,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))});
 const runtime=new PiRuntime({cwd,sessionsDir:path.join(home,'sessions'),skillPaths:[skills],skillContext:async()=> 'primary catalog',executionContext:async()=>({cwd:worker}),model:'skill-fixture/local',contextBudgets:()=>({localModels:['skill-fixture/local']}),personaSections:async()=>['Required authority boundary'],approvals:{mode:'off',tools:[]}});(runtime as any).modelRuntime=async()=>models;
 const wrapped:any=await runtime.open('subagent:skill-fixture');const session=wrapped.session;
 try{
  const original=session.resourceLoader.getSkills().skills;assert.equal(original.length,30);
  const emit=()=>session.extensionRunner.emitBeforeAgentStart({messageType:'user',prompt:'metadata fixture',images:[]},session._baseSystemPromptOptions);
  const local=await emit();assert.deepEqual(local.systemPromptOptions.skills,[]);assert.equal(session.resourceLoader.getSkills().skills.length,30,'SDK skill expansion remains available');
  assert.match(local.systemPromptOptions.appendSystemPrompt,/Required authority boundary/);assert.match(local.systemPromptOptions.appendSystemPrompt,/Available skills: 30/);
  assert.ok(local.systemPromptOptions.appendSystemPrompt.length<2500);assert.equal(session._baseSystemPromptOptions.skills.length,30,'base/default remains available for model switch');
  const file=/catalog (".*?") with bounded/.exec(local.systemPromptOptions.appendSystemPrompt);assert.ok(file);const catalog=JSON.parse(await readFile(JSON.parse(file[1]!), 'utf8'));assert.equal(catalog.length,30);assert.deepEqual(catalog.map((s:any)=>s.filePath),original.map((s:any)=>s.filePath));
  const before=await stat(JSON.parse(file[1]!));await emit();assert.equal((await stat(JSON.parse(file[1]!))).mtimeMs,before.mtimeMs,'unchanged catalog is not rewritten');
  await wrapped.setModel('skill-fixture/frontier');const frontier=await emit();assert.equal(frontier.systemPromptOptions.skills.length,30);assert.doesNotMatch(frontier.systemPromptOptions.appendSystemPrompt,/Available skills: 30/,'no stale local catalog on frontier');
  await session.reload();await session.bindExtensions({});await wrapped.setModel('skill-fixture/local');const reloaded=await emit();assert.deepEqual(reloaded.systemPromptOptions.skills,[]);assert.equal(session.resourceLoader.getSkills().skills.length,30);
  // Unchanged discovery must not hide skills behind a vanished cache hit.
  await rm(JSON.parse(file[1]!));const missing=await emit();assert.equal(missing.systemPromptOptions.skills.length,30);assert.match(missing.systemPromptOptions.appendSystemPrompt,/Required authority boundary/);assert.doesNotMatch(missing.systemPromptOptions.appendSystemPrompt,/Available skills: 30/);
  const recovered=await emit();assert.deepEqual(recovered.systemPromptOptions.skills,[]);assert.equal(JSON.parse(await readFile(JSON.parse(file[1]!), 'utf8')).length,30,'next request repairs missing immutable catalog');
  await writeFile(JSON.parse(file[1]!), 'corrupt catalog');const corrupt=await emit();assert.equal(corrupt.systemPromptOptions.skills.length,30);assert.doesNotMatch(corrupt.systemPromptOptions.appendSystemPrompt,/Available skills: 30/);
  const repaired=await emit();assert.deepEqual(repaired.systemPromptOptions.skills,[]);assert.match(repaired.systemPromptOptions.appendSystemPrompt,/Available skills: 30/);
  assert.deepEqual(JSON.parse(await readFile(JSON.parse(file[1]!), 'utf8')).map((s:any)=>s.filePath),original.map((s:any)=>s.filePath),'corrupt catalog is republished with exact discovered paths');
  // Force the new-catalog path to fail after SDK discovery changes. The SDK
  // catches extension errors; fallback must be explicit, preserve every skill,
  // and still refresh persona/run instructions, not silently return stale data.
  await rm(path.join(home,'skill-catalogs'),{recursive:true,force:true});await writeFile(path.join(home,'skill-catalogs'),'not a directory');
  const source=path.join(skills,'fixture-0','SKILL.md');await writeFile(source,'---\nname: fixture-0\ndescription: changed discovery forces new catalog\n---\nRetained body\n');
  await session.reload();await session.bindExtensions({});const fallback=await emit();
  assert.deepEqual(fallback.systemPromptOptions.skills.map((s:any)=>s.filePath),session.resourceLoader.getSkills().skills.map((s:any)=>s.filePath));
  assert.equal(fallback.systemPromptOptions.skills.length,30);assert.doesNotMatch(fallback.systemPromptOptions.appendSystemPrompt,/Available skills: 30/);assert.match(fallback.systemPromptOptions.appendSystemPrompt,/Required authority boundary/);
 }finally{await wrapped.dispose();}
});
