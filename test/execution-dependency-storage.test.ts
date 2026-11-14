import test from'node:test';import assert from'node:assert/strict';
import{mkdtemp,readFile,writeFile,rm,readdir,stat,symlink}from'node:fs/promises';import path from'node:path';import os from'node:os';
import{ExecutionStore,executionRecoveryHash}from'../src/execution.js';
const dependency={taskId:'original-task',depth:3,original:'Exact authorized task and preserved evidence '.repeat(1600),expiresAt:Date.now()+86400000};
async function fixture(t:any){const home=await mkdtemp(path.join(os.tmpdir(),'execution-dependencies-'));t.after(()=>rm(home,{recursive:true,force:true}));const file=path.join(home,'executions.json');const store=new ExecutionStore(file);await store.load();return{home,file,store};}

test('migration preserves exact private v1 bytes, scopes, all in-memory authority and unchanged payload mtime',async t=>{
 const f=await fixture(t);const first=await f.store.submit('parent','request','same original','direct',1,dependency);
 const legacy=JSON.stringify({version:1,executions:f.store.list(),events:f.store.events()})+'\n';await writeFile(f.file,legacy,{mode:0o600});
 const migrated=new ExecutionStore(f.file);await migrated.load();await migrated.ack('nonexistent-barrier');
 assert.equal(await readFile(f.file+'.legacy-v1','utf8'),legacy);assert.equal((await stat(f.file+'.legacy-v1')).mode&0o777,0o600);
 const disk=JSON.parse(await readFile(f.file,'utf8'));assert.equal(disk.version,2);assert.equal(disk.executions[0].dependency,undefined);assert.ok(disk.executions[0].dependencyRef);assert.ok((await stat(f.file)).size<legacy.length/10);
 const dir=f.file+'.dependencies',name=(await readdir(dir))[0]!,before=(await stat(path.join(dir,name))).mtimeMs;
 await migrated.ack('another-barrier');assert.equal((await stat(path.join(dir,name))).mtimeMs,before);
 const cold=new ExecutionStore(f.file);await cold.load();assert.deepEqual(cold.list(),migrated.list());assert.equal(executionRecoveryHash(cold.list()[0]!),executionRecoveryHash(migrated.list()[0]!),'exact recovery fence survives encoding and restart, including JSON property order');assert.deepEqual(cold.list()[0]!.dependency,dependency);assert.equal((await cold.submit('parent','request','same original','direct',1,dependency)).id,first.id);assert.equal(cold.list()[0]!.dependency!.depth,3);
});

test('missing/corrupt/cross-scope dependency fails closed, never grants an empty snapshot',async t=>{
 const f=await fixture(t);await f.store.submit('parent','one','original','direct',1,dependency);const original=await readFile(f.file,'utf8');const row=JSON.parse(original);const p=path.join(f.file+'.dependencies',row.executions[0].dependencyRef.sha256+'.json');const raw=await readFile(p,'utf8');
 await writeFile(p,raw+'corrupt');await assert.rejects(new ExecutionStore(f.file).load(),/retained execution dependency/);
 await writeFile(p,raw);row.executions[0].parent='other';await writeFile(f.file,JSON.stringify(row));await assert.rejects(new ExecutionStore(f.file).load(),/retained execution dependency/);
 await writeFile(f.file,original);await rm(p);await assert.rejects(new ExecutionStore(f.file).load(),/retained execution dependency/);
 await symlink(f.file,p);await assert.rejects(new ExecutionStore(f.file).load(),/retained execution dependency/);
});

test('staging failure keeps legacy commit and exact backup, subsequent queued mutation can recover',async t=>{
 const f=await fixture(t);const legacy=JSON.stringify({version:1,executions:[],events:[]})+'\n';await writeFile(f.file,legacy,{mode:0o600});const store=new ExecutionStore(f.file);await store.load();await writeFile(f.file+'.dependencies','blocked');
 await assert.rejects(store.submit('parent','one','original','direct',1,dependency));assert.equal(await readFile(f.file,'utf8'),legacy);assert.deepEqual(store.list(),[]);assert.equal(await readFile(f.file+'.legacy-v1','utf8'),legacy);
 await rm(f.file+'.dependencies');const a=await store.submit('parent','one','original','direct',1,dependency);assert.equal(a.status,'ready');const reopened=new ExecutionStore(f.file);await reopened.load();assert.deepEqual(reopened.list(),JSON.parse(JSON.stringify(store.list())));
});
