import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wasmTools, validateWasmTools } from "../src/wasm-tools.js";
import { validateWasmLimits } from "../src/wasm-tool-limits.js";

// (memory 1 2), alloc(i32)->i32 = 0, run(i32,i32)->i64 = unsigned(length).
const header = [0,97,115,109,1,0,0,0];
const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
const fixture = (loop = false) => Buffer.from([...header,
  ...section(1,[2,96,1,127,1,127,96,2,127,127,1,126]),
  ...section(3,[2,0,1]), ...section(5,[1,1,1,2]),
  ...section(7,[3,6,109,101,109,111,114,121,2,0,5,97,108,108,111,99,0,0,3,114,117,110,0,1]),
  ...section(10,loop ? [2,4,0,65,0,11,9,0,3,64,12,0,11,66,0,11] : [2,4,0,65,0,11,5,0,32,1,173,11]),
]);

test("restricted Wasm tools run, refresh file bytes, bound loops and cancel", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wasm-tools-"));
  try {
    const file = path.join(home, "echo.wasm");
    await writeFile(file, fixture());
    const [tool] = wasmTools(home,[{name:"plugin_echo", description:"Echo",path:"echo.wasm",timeoutMs:500}]);
    assert.equal(await tool.execute({input:"Grüße"},{sessionKey:"test"}),"Grüße");
    await writeFile(file, fixture(true));
    await assert.rejects(tool.execute({input:"loop"},{sessionKey:"test"}),/timed out/);
    const controllers = Array.from({length:4},()=>new AbortController());
    const calls = controllers.map(c=>tool.execute({input:"busy"},{sessionKey:"test",signal:c.signal}).catch(e=>e));
    await assert.rejects(tool.execute({input:"overflow"},{sessionKey:"other"}),/capacity/);
    controllers.forEach(c=>c.abort()); await Promise.all(calls);
    const controller = new AbortController();
    const pending = tool.execute({input:"cancel"},{sessionKey:"test",signal:controller.signal});
    setTimeout(()=>controller.abort(),50);
    await assert.rejects(pending,/cancelled/);
    await writeFile(file, fixture());
    assert.equal(await tool.execute({input:"new bytes"},{sessionKey:"test"}),"new bytes");
    await assert.rejects(tool.execute({input:"x".repeat(65537)},{sessionKey:"test"}),/65536/);
    await writeFile(file, Buffer.alloc(1048577));
    await assert.rejects(tool.execute({input:""},{sessionKey:"test"}),/1 MiB/);
    // A valid module importing a host function is denied before instantiation.
    await writeFile(file, Buffer.from([...header,...section(1,[1,96,0,0]),...section(2,[1,1,120,1,121,0,0])]));
    await assert.rejects(tool.execute({input:""},{sessionKey:"test"}),/execution failed/);
  } finally { await rm(home,{recursive:true,force:true}); }
});

test("Wasm resource declarations require bounded memory and tables", () => {
  validateWasmLimits(fixture());
  for (const memory of [[1,0,1], [1,1,1,129,2], [1,3,1,2], [1,5,1,2]]) {
    assert.throws(()=>validateWasmLimits(Buffer.from([...header,...section(5,memory)])),/Wasm/);
  }
  assert.throws(()=>validateWasmLimits(Buffer.from([...header,...section(4,[1,112,0,0])])),/maximum/);
  assert.throws(()=>validateWasmLimits(Buffer.from([...header,5,128])),/Wasm/);
});

test("restricted tools require explicit valid configuration", () => {
  assert.throws(()=>validateWasmTools([{name:"bash",description:"x",path:"x"}]),/Invalid/);
  assert.throws(()=>validateWasmTools([{name:"plugin_x",description:"x",path:"x",timeoutMs:Infinity}]),/Invalid/);
});
