import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore, type PersistedState } from '../src/state.js';
import { prepareSessionState } from '../src/session-state-storage.js';

async function setup(t: any) {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'session-state-'));
 t.after(() => rm(dir, { recursive: true, force: true }));
 return { dir, file: path.join(dir, 'state.json') };
}
const fixture = (): PersistedState => ({version:1,paused:false,busyMode:'queue',sessions:[{key:'matrix:a',heartbeatDisabled:true},{key:'api:b',stopPending:true}],
 pending:[{id:'a1',sessionKey:'matrix:a',source:'channel',text:'one'},{id:'b1',sessionKey:'api:b',source:'api',text:'two'},{id:'a2',sessionKey:'matrix:a',source:'channel',text:'three'}],seen:['a1','b1','a2']});

test('legacy migration preserves exact scope, interleaved inbox ordering, settings and immutable backup',async t=>{
 const {file}=await setup(t);const original=fixture(),raw=JSON.stringify(original);await writeFile(file,raw);
 const store=new StateStore(file);assert.deepEqual(await store.load(),original);await store.capture(()=>original);
 assert.equal(await readFile(file+'.legacy-v1','utf8'),raw);
 const manifest=JSON.parse(await readFile(file,'utf8'));assert.equal(manifest.version,2);assert.equal(manifest.sessions,undefined);assert.equal(manifest.pending,undefined);
 assert.deepEqual(await new StateStore(file).load(),original);
 for(const ref of manifest.refs){const shard=path.join(file+'.sessions',ref.scope,ref.revision+'.json');assert.equal((await stat(shard)).mode&0o777,0o600);}
});

test('changing one session writes only that session, not independent large session payload',async t=>{
 const {file}=await setup(t);const store=new StateStore(file),state=fixture();state.sessions[1]!.heldRecoveryInputs=[{sessionKey:'api:b',source:'api',text:'retained'.repeat(50000)}];
 await store.save(state);const first=JSON.parse(await readFile(file,'utf8'));const b=first.refs[1],bfile=path.join(file+'.sessions',b.scope,b.revision+'.json'),before=await stat(bfile);
 state.sessions[0]!.resetPending=true;await store.save(state);
 const after=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(after.refs[1],b);assert.notEqual(after.refs[0].revision,first.refs[0].revision);assert.equal((await stat(bfile)).mtimeMs,before.mtimeMs);
 assert.ok((await stat(file)).size<2000);assert.equal((await readdir(path.dirname(bfile))).length,1);
 assert.deepEqual(await new StateStore(file).load(),state);
});

test('partial shard failure never publishes a mixed checkpoint; retry does not lose accepted inbox or stop fences',async t=>{
 const {file}=await setup(t);const store=new StateStore(file),initial=fixture();await store.save(initial);const committed=await readFile(file,'utf8');
 const next=fixture();next.sessions.push({key:'new:c',resetPending:true});next.sessions[0]!.stopPending=true;
 const ref=prepareSessionState(next).manifest.refs.at(-1)!;const blocker=path.join(file+'.sessions',ref.scope);await writeFile(blocker,'block directory');
 await assert.rejects(store.save(next));assert.equal(await readFile(file,'utf8'),committed);assert.deepEqual(await new StateStore(file).load(),initial);
 await rm(blocker);await store.save(next);assert.deepEqual(await new StateStore(file).load(),next);
});

test('a missing or modified committed shard is fatal, never an empty session or fallback to legacy work',async t=>{
 const {file}=await setup(t);const store=new StateStore(file);await store.save(fixture());const manifest=JSON.parse(await readFile(file,'utf8')),ref=manifest.refs[0],shard=path.join(file+'.sessions',ref.scope,ref.revision+'.json');
 await writeFile(shard,'{}');await assert.rejects(new StateStore(file).load(),/checksum/);await rm(shard);await assert.rejects(new StateStore(file).load(),/ENOENT/);
});

test('each capture and explicit save retains its own ordered durability barrier',async t=>{
 const {file}=await setup(t);const store=new StateStore(file),seen:number[]=[];
 const a=store.capture(()=>{seen.push(1);return {...fixture(),personality:'one'};});
 const b=store.save({...fixture(),personality:'explicit'});
 const c=store.capture(()=>{seen.push(3);return {...fixture(),personality:'three'};});
 await Promise.all([a,b,c]);assert.deepEqual(seen,[1,3]);assert.equal((await new StateStore(file).load())?.personality,'three');
});

test('active task alias is stored once and restored without changing stop, budget or uncertain-effect evidence',async t=>{
 const {file}=await setup(t);const state=fixture();const task={id:'held',state:'stopped',original:'never replay',depth:4,budget: {remaining:0},effect:'uncertain'} as any;
 state.sessions[0]!.task=task;state.sessions[0]!.tasks=[task];await new StateStore(file).save(state);
 const manifest=JSON.parse(await readFile(file,'utf8')),ref=manifest.refs[0],raw=await readFile(path.join(file+'.sessions',ref.scope,ref.revision+'.json'),'utf8');
 const shard=JSON.parse(raw);assert.equal(shard.session.task,undefined);assert.equal(shard.activeTaskId,'held');
 assert.deepEqual(await new StateStore(file).load(),state);
});


test('a later capture cannot silently replace an earlier inbox, reset fence or uncertain effect before publication',async t=>{
 const {file}=await setup(t);const store=new StateStore(file);const first=fixture();first.sessions[0].resetPending=true;
 first.sessions[0].heldRecoveryInputs=[{sessionKey:'matrix:a',source:'api',text:'uncertain effect; do not replay'}];
 const p=store.capture(()=>first);
 const q=store.capture(()=>{
  const manifest=JSON.parse(readFileSync(file,'utf8')),ref=manifest.refs[0];
  const shard=JSON.parse(readFileSync(path.join(file+'.sessions',ref.scope,ref.revision+'.json'),'utf8'));
  assert.equal(shard.session.resetPending,true);assert.equal(shard.pending[0].id,'a1');
  assert.match(shard.session.heldRecoveryInputs[0].text,/uncertain/);
  return {...fixture(),pending:[]};
 });await Promise.all([p,q]);
});

test('queued explicit A-B-A snapshots never publish a reference retired by an earlier commit',async t=>{
 const {file}=await setup(t);const store=new StateStore(file),a=fixture();await store.save(a);
 const b=fixture();b.sessions[0].resetPending=true;
 await Promise.all([store.save(b),store.save(a)]);assert.deepEqual(await new StateStore(file).load(),a);
});

for(const unsafe of ['different','symlink'])test('migration refuses '+unsafe+' backup without replacing current authority',async t=>{
 const {file,dir}=await setup(t);const raw=JSON.stringify(fixture());await writeFile(file,raw,{mode:0o600});
 if(unsafe==='different')await writeFile(file+'.legacy-v1','unrelated',{mode:0o600});
 else{const target=path.join(dir,'target');await writeFile(target,raw,{mode:0o600});await symlink(target,file+'.legacy-v1');}
 const store=new StateStore(file);await store.load();await assert.rejects(store.capture(()=>fixture()));assert.equal(await readFile(file,'utf8'),raw);
});


test('duplicate legacy task IDs never turn a current stopped task into an earlier active task',async t=>{
 const {file}=await setup(t);const state=fixture(),active={id:'same',state:'active',original:'earlier'},stopped={id:'same',state:'stopped',original:'actual current'};
 state.sessions[0].tasks=[active,stopped] as any;state.sessions[0].task=stopped as any;
 await new StateStore(file).save(state);assert.deepEqual(await new StateStore(file).load(),state);
});
