import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseJobs, Scheduler } from "../src/scheduler.js";
const config = (enabled: unknown) => JSON.stringify({jobs:[{name:"fixture",schedule:"0 0 0 1 1 * 2099",enabled}]});

for (const value of ["false","true",0,1,null,[],{}]) {
  test(`reject nonboolean enabled ${JSON.stringify(value)}`, () => {
    assert.throws(()=>parseJobs(config(value)),/Invalid cron enabled/);
  });
}
test("omitted and boolean values retain parsing semantics", () => {
  for (const value of [undefined,true,false]) assert.equal(parseJobs(config(value))[0].enabled,value);
});

test("invalid enabled reload preserves paused schedule and valid reload recovers", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(),"cron-enabled-"));
  const file = path.join(home,"jobs.yaml");
  const scheduler = new Scheduler({paused:false} as never,{jobsFile:file,timezone:"UTC",log:()=>{}});
  try {
    await writeFile(file,config(false)); await scheduler.load();
    const before = scheduler.list(); assert.equal(before[0].enabled,false);
    await writeFile(file,config("false"));
    await assert.rejects(scheduler.load(),/Invalid cron enabled/);
    assert.deepEqual(scheduler.list(),before);
    await writeFile(file,config(true)); await scheduler.load();
    assert.equal(scheduler.list()[0].enabled,true);
    await writeFile(file,config(undefined)); await scheduler.load();
    assert.equal(scheduler.list()[0].enabled,true);
    await writeFile(file,config(false)); await scheduler.load();
    assert.equal(scheduler.list()[0].enabled,false);
  } finally { scheduler.stop(); await rm(home,{recursive:true,force:true}); }
});
