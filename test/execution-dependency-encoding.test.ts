import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm,chmod,readdir,stat}from'node:fs/promises';import path from'node:path';import os from'node:os';
import{ExecutionDependencyStorage}from'../src/execution-dependency-storage.js';import{executionRecoveryHash}from'../src/execution.js';
test('4096 UTF-8 byte boundary, mixed JSON key ordering and fsGroup restart resealing preserve exact recovery hashes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'execution-encoding-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'ledger.json'),store=new ExecutionDependencyStorage(file);
 const entries=[4095,4096,4097].map((size,i)=>{const dep={taskId:'original',depth:2,original:'🙂'};while(Buffer.byteLength(JSON.stringify(dep))<size)dep.original+='x';return i%2?{id:'id'+i,dependency:dep,parent:'p',status:'blocked',intent:{id:'uncertain'}}:{id:'id'+i,parent:'p',status:'blocked',dependency:dep,intent:{id:'uncertain'}};});
 for(let i=0;i<3;i++)assert.equal(Buffer.byteLength(JSON.stringify(entries[i]!.dependency)),4095+i);
 const rows=await store.stage(entries as any);assert.equal(rows[0]!.dependencyRef,undefined);assert.ok(rows[1]!.dependencyRef);assert.ok(rows[2]!.dependencyRef);
 await chmod(file+'.dependencies',0o770);for(const f of await readdir(file+'.dependencies'))await chmod(path.join(file+'.dependencies',f),0o660);
 const cold=new ExecutionDependencyStorage(file);const hydrated=await cold.hydrate(rows);assert.deepEqual(hydrated,entries);assert.deepEqual(hydrated.map(executionRecoveryHash),entries.map(e=>executionRecoveryHash(e as any)));
 await cold.stage(hydrated);assert.equal((await stat(file+'.dependencies')).mode&0o777,0o700);for(const f of await readdir(file+'.dependencies'))assert.equal((await stat(path.join(file+'.dependencies',f))).mode&0o777,0o600);
});
