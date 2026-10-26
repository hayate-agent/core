import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { SettingsService } from "../src/settings.js";

test("unsupported skills section warns without blocking startup and survives later writes", async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'settings-tolerant-')); t.after(()=>rm(home,{recursive:true,force:true}));
 const file=path.join(home,'settings.local.yaml');
 await writeFile(file,'skills:\n  paths: [private-path]\nmodel: local/test\n');
 const warnings:string[]=[];
 const settings=new SettingsService(file,{},message=>warnings.push(message));await settings.load();
 assert.equal(settings.effective().model,'local/test');assert.equal((settings.effective() as any).skills,undefined);
 assert.equal(warnings.length,1);assert.match(warnings[0]!,/NOT active/);assert.doesNotMatch(warnings[0]!,/private-path/);
 await settings.set('thinking','off');
 assert.deepEqual(parse(await readFile(file,'utf8')).skills,{paths:['private-path']});
 const restarted=new SettingsService(file,{});await restarted.load();assert.equal(restarted.effective().thinking,'off');
 await writeFile(file,'skills: {}\ndispatcher:\n  enabled: true\n');
 await assert.rejects(new SettingsService(file,{}).load(),/concurrentRequests/);
 await writeFile(file,'model: 42\nskills: {}\n');
 await assert.rejects(new SettingsService(file,{}).load());
});
