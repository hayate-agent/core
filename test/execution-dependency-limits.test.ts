import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import path from'node:path';import os from'node:os';import{ExecutionDependencyStorage}from'../src/execution-dependency-storage.js';
test('exact serialized 32MiB shard reader boundary is enforced before publication',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dependency-limit-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new ExecutionDependencyStorage(path.join(dir,'ledger'));
 const task:any={id:'id',parent:'parent',dependency:{taskId:'original',depth:1,original:''},status:'blocked'};const envelope=()=>JSON.stringify({version:1,id:task.id,parent:task.parent,dependency:task.dependency})+'\n';const max=32*1024*1024;task.dependency.original='x'.repeat(max-Buffer.byteLength(envelope()));assert.equal(Buffer.byteLength(envelope()),max);
 const staged=await store.stage([task]);const restored=await new ExecutionDependencyStorage(path.join(dir,'ledger')).hydrate(staged);assert.equal(restored[0]!.dependency!.original,task.dependency.original);
 const bigger={...task,dependency:{...task.dependency,original:task.dependency.original+'x'}};await assert.rejects(store.stage([bigger]),/exceeds reader budget/);
});
