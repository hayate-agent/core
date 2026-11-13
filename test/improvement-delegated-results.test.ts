import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController } from "../src/improvement.js";
import nightlyDefault from "../src/builtin-plugins/nightly-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import type { Execution } from "../src/execution.js";

const KEY = "improvement:nightly";
const receipt = '```improvement-experiment\n' + JSON.stringify({execution: "performed", hypothesis: "new delegated fixture", baseline: "baseline measured", candidate: "candidate tested", evidence: "synthetic fixture passed", outcome: "inconclusive"}) + '\n```\n[IMPROVEMENT_DONE]';

async function fixture(t: any, overrides = {}, now = Date.parse("2026-11-13T10:00:00Z")) {
 const home = await mkdtemp(path.join(os.tmpdir(), "nightly-result-"));
 t.after(() => rm(home, {recursive: true, force: true}));
 await mkdir(path.join(home, "improvement"));
 await writeFile(path.join(home, "improvement/state.json"), JSON.stringify({version:1, night:"2026-11-12", turns:8, results:[], experiments:[], recentHypotheses:[], noExperimentTurns:3, done:true, ...overrides}));
 const runtime = new FakeRuntime();
 const harness = new Harness({runtime, tickMs:60000});
 const task = {id:"fixture-child",parent:KEY,status:"completed",result:receipt,dependency:{taskId:"improvement:2026-11-12:8",original:"original authorized nightly work",depth:0}} as Execution;
 const tasks = [task];
 const controller = new ImprovementController(home,harness,"UTC",()=>now,nightlyDefault,undefined,()=>tasks);
 t.after(() => harness.stop(1000));
 const state = async () => JSON.parse(await readFile(path.join(home,"improvement/state.json"),"utf8"));
 return {home,runtime,harness,task,tasks,controller,state};
}

test("completed child result outside window/after done is evidence, never a fresh work turn or closure",async t=>{
 const f=await fixture(t);
 assert.equal(await f.controller.delegatedResult(f.task.id),true);
 let state=await f.state();
 assert.equal(state.turns,8);assert.equal(state.done,true);assert.equal(state.experiments.length,1);
 assert.deepEqual(state.delegatedResults,[f.task.id]);assert.equal(f.runtime.sessions.size,0);
 await Promise.all([f.controller.delegatedResult(f.task.id),f.controller.delegatedResult(f.task.id)]);
 state=await f.state();assert.equal(state.results.length,1);assert.equal(state.experiments.length,1);
 const restored=new ImprovementController(f.home,f.harness,"UTC",()=>Date.parse("2026-11-13T10:00Z"),nightlyDefault,undefined,()=>f.tasks);
 await restored.delegatedResult(f.task.id);assert.equal((await f.state()).results.length,1);
});

test("duplicate hypothesis in another child is evidence but not another empty experiment attempt",async t=>{
 const f=await fixture(t,{noExperimentTurns:2,recentHypotheses:["new delegated fixture"]});
 await f.controller.delegatedResult(f.task.id);
 const state=await f.state();assert.equal(state.noExperimentTurns,2);assert.equal(state.experiments.length,0);assert.equal(state.turns,8);
});

test("child marker cannot close an open night or replace its pending turn",async t=>{
 const f=await fixture(t,{done:false,pending:"improvement:2026-11-12:9"});
 await f.controller.delegatedResult(f.task.id);
 const state=await f.state();assert.equal(state.done,false);assert.equal(state.turns,8);assert.equal(state.pending,"improvement:2026-11-12:9");
});

test("forged text, wrong parent/night and future task numbers do not adopt receipts",async t=>{
 const f=await fixture(t);
 assert.equal(await f.controller.delegatedResult("model-invented-id"),false);
 f.task.parent="matrix:unrelated";assert.equal(await f.controller.delegatedResult(f.task.id),false);
 f.task.parent=KEY;f.task.dependency!.taskId="improvement:2026-11-11:8";await f.controller.delegatedResult(f.task.id);
 f.task.dependency!.taskId="improvement:2026-11-12:80";await f.controller.delegatedResult(f.task.id);
 f.task.dependency!.taskId="improvement:2026-11-12:8-forged";await f.controller.delegatedResult(f.task.id);
 assert.equal((await f.state()).results.length,0);
});

test("in-flight delegated work defers another nightly turn and does not count as empty experiment",async t=>{
 const f=await fixture(t,{turns:7,done:false,pending:"improvement:2026-11-12:8",noExperimentTurns:2},Date.parse("2026-11-12T23:30:00Z"));
 f.task.status="running";
 await f.controller.before({id:"improvement:2026-11-12:8",sessionKey:KEY,source:"cron",text:"existing mandate"});
 await f.controller.completed({id:"improvement:2026-11-12:8",sessionKey:KEY,source:"cron",text:"existing mandate"},"Delegated, waiting for actual evidence.");
 let state=await f.state();assert.equal(state.noExperimentTurns,2);assert.equal(state.done,false);
 await f.controller.tick();state=await f.state();assert.equal(state.turns,8);assert.equal(state.pending,undefined);assert.equal(f.runtime.sessions.size,0);
 f.task.status="completed";await f.controller.delegatedResult(f.task.id);assert.equal((await f.state()).experiments.length,1);
});

test("receipt adoption waits for parent commit and startup reconciles completed ledger evidence",async t=>{
 const f=await fixture(t);
 f.harness.state(KEY).running=true;
 await f.controller.delegatedResult(f.task.id);assert.equal((await f.state()).results.length,0);
 f.harness.state(KEY).running=false;
 await f.controller.tick();assert.equal((await f.state()).experiments.length,1);
 assert.equal(f.runtime.sessions.size,0);
});
