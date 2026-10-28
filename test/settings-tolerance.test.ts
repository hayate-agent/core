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

test("dispatcher rules pass through the settings overlay and validate", async () => {
  const { SettingsService } = await import("../src/settings.js");
  const { writeFile, readFile, mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "settings-rules-"));
  const file = path.join(dir, "settings.local.yaml");
  try {
    await writeFile(file, "skills: {}\ndispatcher:\n  enabled: true\n  concurrentRequests: true\n  rules:\n    - match: {minChars: 1200}\n      model: p/big\n      thinking: medium\n    - match: {}\n      model: p/small\n");
    const settings = new SettingsService(file, {});
    await settings.load();
    assert.deepEqual(settings.effective().dispatcher.rules, [
      { match: { minChars: 1200 }, model: "p/big", thinking: "medium" },
      { match: {}, model: "p/small" },
    ]);
    await writeFile(file, "skills: {}\ndispatcher:\n  rules:\n    - match: {nonsense: 1}\n      model: p/big\n");
    await assert.rejects(new SettingsService(file, {}).load(), /Invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
