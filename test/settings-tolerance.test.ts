import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { SettingsService } from "../src/settings.js";

test("skills section is a supported overlay: active, validated, preserved through later writes", async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'settings-tolerant-')); t.after(()=>rm(home,{recursive:true,force:true}));
 const file=path.join(home,'settings.local.yaml');
 await writeFile(file,'skills:\n  paths: [private-path]\n  context: lazy\nmodel: local/test\n');
 const warnings:string[]=[];
 const settings=new SettingsService(file,{},message=>warnings.push(message));await settings.load();
 assert.equal(settings.effective().model,'local/test');assert.deepEqual((settings.effective() as any).skills,{paths:['private-path'],context:'lazy'});
 assert.equal(warnings.length,0);
 await settings.set('thinking','off');
 assert.equal(parse(await readFile(file,'utf8')).skills.context,'lazy');
 const restarted=new SettingsService(file,{});await restarted.load();assert.equal(restarted.effective().thinking,'off');assert.equal(restarted.effective().skills.context,'lazy');
 await writeFile(file,'skills:\n  context: bogus\nmodel: local/test\n');
 await assert.rejects(new SettingsService(file,{}).load(),/Invalid skills\.context/);
 await writeFile(file,'skills: {}\ndispatcher:\n  enabled: true\n');
 await assert.rejects(new SettingsService(file,{}).load(),/concurrentRequests/);
 await writeFile(file,'model: 42\nskills: {}\n');
 await assert.rejects(new SettingsService(file,{}).load());
});
