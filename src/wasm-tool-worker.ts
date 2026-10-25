import { parentPort, workerData } from "node:worker_threads";

// No WASI, JS callbacks, filesystem, environment, clock or network imports.
const run = async () => {
  const module = await WebAssembly.compile(workerData.bytes);
  if (WebAssembly.Module.imports(module).length) throw Error("Wasm tools must not import host capabilities");
  const instance = await WebAssembly.instantiate(module, {});
  const { memory, alloc, run } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof alloc !== "function" || typeof run !== "function") throw Error("Invalid Wasm tool ABI");
  const input = new TextEncoder().encode(workerData.input);
  const ptr = alloc(input.length);
  if (!Number.isInteger(ptr) || ptr < 0 || ptr + input.length > memory.buffer.byteLength) throw Error("Invalid input buffer");
  new Uint8Array(memory.buffer, ptr, input.length).set(input);
  // run returns packed i64: upper 32 bits pointer, lower 32 bits byte length.
  const output = run(ptr, input.length);
  if (typeof output !== "bigint") throw Error("Invalid result ABI");
  const offset = Number(BigInt.asUintN(64, output) >> 32n);
  const length = Number(BigInt.asUintN(32, output));
  if (length > 65536 || offset + length > memory.buffer.byteLength) throw Error("Invalid output buffer");
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(memory.buffer, offset, length));
};
void run().then(result => parentPort!.postMessage({ result }), () => parentPort!.postMessage({ error: "Wasm tool execution failed" }));
