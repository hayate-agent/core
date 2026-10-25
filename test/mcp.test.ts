import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";

const exec = promisify(execFile);

test("MCP stdio discovery is opt-in and closes its server on session shutdown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-mcp-"));
  try {
    const server = path.join(dir, "server.mjs");
    await writeFile(server, `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined) return;
 const result=m.method==='initialize' ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 :m.method==='tools/list' ? {tools:[{name:'echo',description:'Test echo',inputSchema:{type:'object',properties:{}}}]}
 :m.method==='tools/call' ? {content:[{type:'text',text:'fixture reply'}]} : {};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});
`);
    await writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server, path.join(dir, "pid")], exposure: "direct" } } }));
    const code = `
import { PiRuntime } from './src/runtime/pi.ts';
import { access, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const options={cwd:process.cwd(),sessionsDir:process.env.TEST_DIR+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]}};
for (const extra of [{}, {mcp:{enabled:true},tools:[]}]) {
 const inactive=await new PiRuntime({...options,...extra}).open('inactive');
 await new Promise(r=>setTimeout(r,100));
 await assert.rejects(access(process.env.TEST_DIR+'/pid'));
 await inactive.dispose();
}
const runtime=new PiRuntime({cwd:process.cwd(),sessionsDir:process.env.TEST_DIR+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},mcp:{enabled:true}});
const wrapped=await runtime.open('fixture');
const session=wrapped.session;
const deadline=Date.now()+10000;
while(!session.getAllTools().some(t=>t.name==='mcp__fixture__echo') && Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
if(!session.getAllTools().some(t=>t.name==='mcp__fixture__echo')) throw Error('MCP tool not discovered');
const tool=session.extensionRunner.getToolDefinition('mcp__fixture__echo');
const result=await tool.execute('call',{},undefined,undefined,{});
assert.equal(result.content[0].text,'fixture reply');
const pid=Number(await readFile(process.env.TEST_DIR+'/pid','utf8'));
await runtime.reload();
process.kill(pid,0); // reload request never closes a live session mid-turn
// Exercise the real prompt boundary and SDK/MCP reload without an LLM request.
let prompts=0;
session.prompt=async()=>{prompts++;};
session.waitForIdle=async()=>{};
const manager=session.sessionManager;
await wrapped.prompt('after reload');
assert.equal(prompts,1);
assert.equal(session.sessionManager,manager,'history manager is retained');
assert.throws(()=>process.kill(pid,0),'old server closed at prompt boundary');
const reloadDeadline=Date.now()+10000;
let replacement=pid;
while(replacement===pid && Date.now()<reloadDeadline) {
 replacement=Number(await readFile(process.env.TEST_DIR+'/pid','utf8'));
 if(replacement===pid) await new Promise(r=>setTimeout(r,25));
}
assert.notEqual(replacement,pid,'replacement server started');
await wrapped.prompt('unchanged');
assert.equal(Number(await readFile(process.env.TEST_DIR+'/pid','utf8')),replacement,'no duplicate reload');
const configPath=process.env.TEST_DIR+'/mcp.json';
const originalConfig=await readFile(configPath,'utf8');
await writeFile(configPath,'{broken');
await assert.rejects(wrapped.prompt('invalid config'),/not valid JSON/);
process.kill(replacement,0); // rejected before shutting down the working configuration
await writeFile(configPath,originalConfig.replace('"fixture":','"changed":'));
await wrapped.prompt('automatic discovery');
assert.throws(()=>process.kill(replacement,0));
const autoDeadline=Date.now()+10000;
while(!session.getAllTools().some(t=>t.name==='mcp__changed__echo') && Date.now()<autoDeadline) await new Promise(r=>setTimeout(r,25));
assert.ok(session.getAllTools().some(t=>t.name==='mcp__changed__echo'));
assert.ok(!session.getAllTools().some(t=>t.name==='mcp__fixture__echo'),'removed tools disappear');
const finalPid=Number(await readFile(process.env.TEST_DIR+'/pid','utf8'));
await wrapped.dispose();
assert.throws(()=>process.kill(finalPid,0)); // closed while the owning process is still alive
console.log('DISCOVERED');
`;
    const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: dir, TEST_DIR: dir }, timeout: 20000,
    });
    assert.match(result.stdout, /DISCOVERED/);
    const pid = Number(await readFile(path.join(dir, "pid"), "utf8"));
    const deadline = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 25)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, "stdio server must not survive the owning session process");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
