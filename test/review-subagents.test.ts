// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ReviewSubagents } from "../src/review-subagents.js";
import { FakeRuntime } from "./fakes.js";

test("dedicated review subagent persists parent, candidate and result provenance", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(),"review-child-"));
  const runtime = new FakeRuntime(() => '{"findings":[]}');
  const agents = new ReviewSubagents(runtime,home);
  try {
    const result = await agents.review({cwd:home,sessionKey:"parent",fingerprint:"exact",prompt:"review",thinking:"low"});
    const record = JSON.parse(await readFile(path.join(home,`${result.executionId}.json`),"utf8"));
    assert.equal(record.parent,"parent");assert.equal(record.fingerprint,"exact");
    assert.equal(record.state,"completed");assert.equal(record.result,result.result);assert.equal(record.tools,"disabled");
    assert.ok(runtime.opened[0].key.startsWith("review-subagent:"));
  }finally{await agents.stop();await rm(home,{recursive:true,force:true});}
});
test("restart marks stale running child interrupted without replay", async () => {
  const home=await mkdtemp(path.join(os.tmpdir(),"review-child-restart-"));
  const old="11111111-1111-4111-8111-111111111111";
  await writeFile(path.join(home,`${old}.json`),JSON.stringify({version:1,id:old,parent:"old-parent",fingerprint:"old",state:"running"}));
  const runtime=new FakeRuntime(()=>'{"findings":[]}');const agents=new ReviewSubagents(runtime,home);
  try {
    await agents.review({cwd:home,sessionKey:"new-parent",fingerprint:"new",prompt:"review",thinking:"low"});
    assert.equal(JSON.parse(await readFile(path.join(home,`${old}.json`),"utf8")).state,"interrupted");
    assert.equal(runtime.opened.length,1);
  }finally{await agents.stop();await rm(home,{recursive:true,force:true});}
});

test("subagent stop drains child before returning and records cancellation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(),"review-child-stop-"));
  const runtime = new FakeRuntime(); const open=runtime.open.bind(runtime);
  runtime.open=async(key,options)=>{const session=await open(key,options);runtime.sessions.get(key)!.hold();return session;};
  const agents=new ReviewSubagents(runtime,home);
  try {
    const pending=agents.review({cwd:home,sessionKey:"parent",fingerprint:"exact",prompt:"review",thinking:"low"});
    const rejected=assert.rejects(pending,/cancelled/);
    while(!runtime.sessions.size || ![...runtime.sessions.values()][0].busy)await new Promise(r=>setTimeout(r,1));
    await agents.stop();await rejected;
    const record=JSON.parse(await readFile(path.join(home,(await readdir(home))[0]),"utf8"));
    assert.equal(record.state,"cancelled");
  }finally{await agents.stop();await rm(home,{recursive:true,force:true});}
});
