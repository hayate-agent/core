import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir,writeFile,readFile,rm,rename,readdir,chmod,symlink}from'node:fs/promises';import os from'node:os';import path from'node:path';
import{ExecutionStore}from'../src/execution.js';
async function fixture(t:any){const dir=await mkdtemp(path.join(os.tmpdir(),'dependency-fault-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'executions.json'),s=new ExecutionStore(file);await s.load();return{file,s};}
const dep={taskId:'task',depth:1,original:'evidence '.repeat(1000)};
test('known shard deletion repaired, corruption/unsafe permissions fail before publishing',async t=>{
 const{file,s}=await fixture(t);await s.submit('p','r','original','direct',1,dep);const raw=await readFile(file,'utf8'),shard=path.join(file+'.dependencies',(await readdir(file+'.dependencies'))[0]!);const bytes=await readFile(shard);
 await rm(shard);await s.ack('barrier');assert.deepEqual(await readFile(shard),bytes);await writeFile(shard,'corrupt');await assert.rejects(s.ack('barrier'));assert.equal(await readFile(file,'utf8'),raw);
 await writeFile(shard,bytes);await chmod(shard,0o644);await assert.rejects(s.ack('barrier'));assert.equal(await readFile(file,'utf8'),raw);
 await chmod(shard,0o600);await s.ack('barrier');await rm(shard);await symlink(file,shard);await assert.rejects(s.ack('barrier'));assert.equal(await readFile(file,'utf8'),raw);
});
test('manifest rename failure before publication keeps old authority and permits a safe queued retry',async t=>{
 const{file,s}=await fixture(t);await s.submit('p','r','original','direct',1,dep);const raw=await readFile(file,'utf8');await rename(file,file+'.saved');await mkdir(file);
 await assert.rejects(s.ack('barrier'));await rm(file,{recursive:true});await rename(file+'.saved',file);await s.ack('safe retry of unchanged authority');assert.equal(await readFile(file,'utf8'),raw);
 const cold=new ExecutionStore(file);await cold.load();assert.equal(cold.list().length,1);await cold.ack('barrier');
});
test('conflicting legacy backup is preserved and never silently overwritten',async t=>{
 const{file}=await fixture(t);const raw=JSON.stringify({version:1,executions:[],events:[]})+'\n';await writeFile(file,raw,{mode:0o600});await writeFile(file+'.legacy-v1','older exact audit',{mode:0o600});const s=new ExecutionStore(file);await s.load();await assert.rejects(s.submit('p','r','original','direct',1,dep));assert.equal(await readFile(file,'utf8'),raw);assert.equal(await readFile(file+'.legacy-v1','utf8'),'older exact audit');
});
