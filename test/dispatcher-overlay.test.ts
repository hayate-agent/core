// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SettingsService } from "../src/settings.js";

test("local dispatcher overlay activates and preserves inherited fields", async t => {
 const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-overlay-"));
 t.after(() => rm(home, {recursive:true,force:true}));
 const file = path.join(home,"settings.local.yaml");
 await writeFile(file,"dispatcher:\n  enabled: true\n  capacity: 2\n");
 const settings = new SettingsService(file,{dispatcher:{enabled:false,concurrentRequests:true,strategy:"direct",retentionDays:14}});
 await settings.load();
 assert.deepEqual(settings.effective().dispatcher,{enabled:true,concurrentRequests:true,strategy:"direct",capacity:2,retentionDays:14});
 await writeFile(file,"dispatcher:\n  enabled: true\n");
 const unsafe = new SettingsService(file,{}); await unsafe.load(); assert.equal(unsafe.effective().dispatcher?.enabled,false);
 await writeFile(file,"dispatcher:\n  enabled: false\n  unexpected: true\n");
 const mixed = new SettingsService(file,{}); await mixed.load(); assert.equal(mixed.effective().dispatcher?.enabled,false);
 assert.ok(mixed.diagnostics.length);
});
