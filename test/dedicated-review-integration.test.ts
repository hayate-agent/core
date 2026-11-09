import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../src/changeset.js";
import { reviewConfig } from "./review-test-config.js";
import { ReviewService } from "../src/builtin-plugins/review.js";
import { ReviewWorkers } from "../src/review-execution.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime } from "./fakes.js";

test("materialized review plugin enforces actual dedicated dispatcher execution and keeps its own budget", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-integration-"));
  const runtime = new FakeRuntime(() => '{"findings":[]}');
  const workers = new ReviewWorkers(runtime,new ExecutionStore(path.join(home,"executions.json")));
  try {
    await writeFile(path.join(home,".gitignore"),"executions.json\nexecutions.json.*.tmp\nreviews/\n");
    await git(home,["init"]);await git(home,["config","user.name","Test"]);await git(home,["config","user.email","test@example.invalid"]);
    await writeFile(path.join(home,"a.ts"),"before");await git(home,["add","a.ts"]);await git(home,["commit","-m","base"]);
    const backend = { review: async () => { throw Error("general main-context backend forbidden"); } };
    const service = new ReviewService(home,reviewConfig(),backend,async()=>{}, {
      dispatcherEnabled:()=>true,dispatcherWorker: request=>workers.review(request),
    });
    await service.prepare(home);await writeFile(path.join(home,"a.ts"),"after");
    const result = await service.run(home,"parent");
    assert.equal(result.status,"passed");assert.equal(result.rounds.length,1);
    assert.equal(runtime.opened.length,1);assert.ok(runtime.opened[0].key.startsWith("dispatch:"));
    assert.equal(result.approvedFingerprint,result.rounds[0].fingerprint);
  }finally{await workers.stop();await rm(home,{recursive:true,force:true});}
});
