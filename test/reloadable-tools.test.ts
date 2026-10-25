import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReloadableTools } from "../src/reloadable-tools.js";

const moduleText=(value:string,extra="")=>`export default {apiVersion:1,activate(api){api.registerTool({name:'plugin_reload',description:'Reload test',parameters:{type:'object'},async execute(){return '${value}'}});${extra}}};`;
test("tool-only reload keeps stable delegates and rolls back invalid candidates",async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),"tool-reload-"));
 const host=new ReloadableTools({home,cwd:home,agent:"test"},["tool.mjs"]);
 try {
  await writeFile(path.join(home,"tool.mjs"),moduleText("one"));await host.reload();
  const tool=host.tools.get("plugin_reload")!;
  assert.equal(await tool.execute({},{sessionKey:"test"}),"one");
  await writeFile(path.join(home,"tool.mjs"),moduleText("two"));await host.reload();
  assert.equal(host.tools.get("plugin_reload"),tool);
  assert.equal(await tool.execute({},{sessionKey:"test"}),"two");
  await writeFile(path.join(home,"tool.mjs"),moduleText("bad","api.registerCommand({name:'unsafe',help:'x',async run(){}});"));
  await assert.rejects(host.reload(),/tools only/);
  assert.equal(await tool.execute({},{sessionKey:"test"}),"two");
  await writeFile(path.join(home,"tool.mjs"),moduleText("bad").replace("Reload test","changed"));
  await assert.rejects(host.reload(),/unchanged/);
  assert.equal(await tool.execute({},{sessionKey:"test"}),"two");
  await host.stop();await assert.rejects(tool.execute({},{sessionKey:"test"}),/stopped/);
 } finally {await host.stop();await rm(home,{recursive:true,force:true});}
});


test("in-flight invocation retains old generation until cleanup",async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),"tool-reload-flight-"));
 const host=new ReloadableTools({home,cwd:home,agent:"test"},["tool.mjs"]);
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});
 const key="reloadFixture"+Date.now();
 (globalThis as any)[key]={gate,entered,cleanups:0};
 try {
  await writeFile(path.join(home,"tool.mjs"),`export default {apiVersion:1,activate(api){api.onStop(()=>{globalThis['${key}'].cleanups++});api.registerTool({name:'plugin_reload',description:'Reload test',parameters:{type:'object'},async execute(){globalThis['${key}'].entered();await globalThis['${key}'].gate;return 'old'}})}};`);
  await host.reload();const tool=host.tools.get("plugin_reload")!;
  const pending=tool.execute({},{sessionKey:"test"});await started;
  await writeFile(path.join(home,"tool.mjs"),moduleText("new"));await host.reload();
  assert.equal((globalThis as any)[key].cleanups,0);
  assert.equal(await tool.execute({},{sessionKey:"test"}),"new");
  release();assert.equal(await pending,"old");
  assert.equal((globalThis as any)[key].cleanups,1);
 } finally {release();await host.stop();delete (globalThis as any)[key];await rm(home,{recursive:true,force:true});}
});
