import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import os from "node:os"; import path from "node:path"; import { createHash } from "node:crypto";
import { ExecutionStore } from "../src/execution.js";

async function fixture(t: { after(fn: () => unknown): void }, blocked = true) {
 const dir = await mkdtemp(path.join(os.tmpdir(), "contradictory-completion-")); t.after(() => rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,"executions.json"),store=new ExecutionStore(file);await store.load();
 const task=await store.submit("parent","original","Deliver a passing integration, not a report of failure","sequential"),claim=await store.claim(task.id);
 const result=blocked?"Required positive test FAILED; source PR remains OPEN\nSTEP-STATUS: blocked: acceptance unmet":"Required positive integration and source merge verified\nSTEP-STATUS: complete";
 const checkpoint=JSON.stringify({v:1,planner:{requested:{}},plan:[{task:"deliver passing integration",role:"simple",reason:"bounded",evidence:"passing positive and merge"}],outcomes:[{role:"simple",requested:{model:"p/working",thinking:"low"},result}]});
 await store.workerSession(task.id,claim.token!,`dispatch:${task.id}:${claim.token}`);
 await store.intent(task.id,claim.token!,`step:${task.id}:0:simple`,"unsafe",{model:"p/working",thinking:"low"},0);
 await store.settleIntent(task.id,claim.token!,`step:${task.id}:0:simple`,result,checkpoint,0);
 await store.complete(task.id,claim.token!,"incorrect legacy completed receipt",0);
 for(const event of store.events())await store.ack(event.id);
 return{dir,file,store,task,checkpoint,hash:createHash("sha256").update(checkpoint).digest("hex")};
}

test("native owner reopens only contradictory completion, archives original receipt and preserves all effects/identity",async t=>{
 const f=await fixture(t),before=f.store.list()[0]!;
 const after=await f.store.reopenContradictoryCompletion("parent",f.task.id,"operator-review","Failed required positive case is not completion; reassess only",f.hash,0);
 assert.equal(after.id,before.id);assert.equal(after.input,before.input);assert.equal(after.status,"ready");assert.deepEqual(after.settledEffect,before.settledEffect);assert.equal(after.intent,undefined);
 const state=JSON.parse(after.checkpoint!);assert.equal(state.outcomes.length,0);assert.match(state.assessment.reply,/positive test FAILED/);assert.equal(state.assessment.reopenedReviewOnly,true);assert.equal(state.assessment.effectsUnknown,true);
 const scope=createHash("sha256").update(JSON.stringify(["parent",f.task.id])).digest("hex"),directory=path.join(f.dir,"execution-reopen-audit",scope);
 const files=await readdir(directory);assert.equal(files.length,1);assert.deepEqual(JSON.parse(await readFile(path.join(directory,files[0]!),"utf8")).original,JSON.parse(JSON.stringify(before)));
 const retry=await f.store.reopenContradictoryCompletion("parent",f.task.id,"operator-review","Failed required positive case is not completion; reassess only",f.hash,0);assert.equal(retry.id,after.id);
 await assert.rejects(f.store.reopenContradictoryCompletion("parent",f.task.id,"operator-review","changed",f.hash,0));
 const reload=new ExecutionStore(f.file);await reload.load();assert.equal(reload.list()[0]!.id,before.id);assert.deepEqual(JSON.parse(reload.list()[0]!.checkpoint!),state);
});

test("honest completion, wrong scope, stale checkpoint and cancelled records are not revived",async t=>{
 const honest=await fixture(t,false);await assert.rejects(honest.store.reopenContradictoryCompletion("parent",honest.task.id,"no","no",honest.hash,0));assert.equal(honest.store.list()[0]!.status,"completed");
 const f=await fixture(t);await assert.rejects(f.store.reopenContradictoryCompletion("foreign",f.task.id,"no","no",f.hash,0));
 await assert.rejects(f.store.reopenContradictoryCompletion("parent",f.task.id,"no","no","0".repeat(64),0));
 await assert.rejects(f.store.reopenContradictoryCompletion("parent",f.task.id,"no","no",f.hash,1));
 assert.equal(f.store.list()[0]!.status,"completed");
});
