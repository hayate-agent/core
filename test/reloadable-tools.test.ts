import { reloadableToolsPlugin } from "../src/builtin-plugins/reloadable-tools-plugin.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginHost } from "../src/plugins.js";
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


test("bundled reload command registers admin policy and stable tool delegates",async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),"tool-reload-command-"));
 const manager=new ReloadableTools({home,cwd:home,agent:"test"},["tool.mjs"]);
 const host=new PluginHost();
 try {
  await writeFile(path.join(home,"tool.mjs"),moduleText("before"));
  await host.load([],{home,cwd:home,agent:"test"},[],[],[reloadableToolsPlugin(manager)]);
  const command=host.commands.get("tool-plugin")!;
  assert.equal(command.admin,true);
  assert.match(await command.run("",{sessionKey:"test"}) as string,/1 tool/);
  const delegate=host.tools.get("plugin_reload")!;
  await writeFile(path.join(home,"tool.mjs"),moduleText("after"));
  assert.equal(await command.run("reload",{sessionKey:"test"}),"Tool plugins reloaded");
  assert.equal(await delegate.execute({},{sessionKey:"test"}),"after");
  await assert.rejects(command.run("unexpected",{sessionKey:"test"}),/usage/);
  await host.stop();await assert.rejects(delegate.execute({},{sessionKey:"test"}),/stopped/);
 } finally {await host.stop();await rm(home,{recursive:true,force:true});}
});

test("stop during candidate activation prevents publication and cleans candidate",async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),"tool-reload-stop-"));
 const manager=new ReloadableTools({home,cwd:home,agent:"test"},["tool.mjs"]);
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});
 const key="reloadStopFixture"+Date.now();
 (globalThis as any)[key]={gate,entered,cleanups:0};
 try {
  await writeFile(path.join(home,"tool.mjs"),moduleText("baseline"));await manager.reload();
  const tool=manager.tools.get("plugin_reload")!;
  await writeFile(path.join(home,"tool.mjs"),`export default {apiVersion:1,async activate(api){api.onStop(()=>globalThis['${key}'].cleanups++);globalThis['${key}'].entered();await globalThis['${key}'].gate;api.registerTool({name:'plugin_reload',description:'Reload test',parameters:{type:'object'},async execute(){return 'must not publish'}})}};`);
  const pending=manager.reload();await started;
  await assert.rejects(manager.reload(),/unavailable/);
  await manager.stop();release();await assert.rejects(pending,/stopped/);
  assert.equal((globalThis as any)[key].cleanups,1);
  await assert.rejects(tool.execute({},{sessionKey:"test"}),/stopped/);
 } finally {release();await manager.stop();delete (globalThis as any)[key];await rm(home,{recursive:true,force:true});}
});


test("automatic refresh detects entry changes and preserves previous generation on failure",async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),"tool-auto-reload-"));
 const manager=new ReloadableTools({home,cwd:home,agent:"test"},["tool.mjs"]);
 try {
  const file=path.join(home,"tool.mjs");
  await writeFile(file,moduleText("first"));await manager.reload();
  const tool=manager.tools.get("plugin_reload")!;
  await Promise.all([manager.refresh(),manager.refresh()]);
  await writeFile(file,moduleText("second"));
  await Promise.all([manager.refresh(),manager.refresh()]);
  assert.equal(await tool.execute({},{sessionKey:"test"}),"second");
  await writeFile(file,"invalid javascript");await assert.rejects(manager.refresh());
  assert.equal(await tool.execute({},{sessionKey:"test"}),"second");
  await writeFile(file,moduleText("repaired"));await manager.refresh();
  assert.equal(await tool.execute({},{sessionKey:"test"}),"repaired");
 } finally {await manager.stop();await rm(home,{recursive:true,force:true});}
});
