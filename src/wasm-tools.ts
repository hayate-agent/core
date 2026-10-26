import { Worker } from "node:worker_threads";
import { open } from "node:fs/promises";
import { constants } from "node:fs";

let activeCalls = 0;
const maxCalls = 4;
const maxModuleBytes = 1048576;

async function readModule(file: string): Promise<Buffer> {
  // O_NONBLOCK prevents a configured FIFO from holding a slot indefinitely.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxModuleBytes) throw Error("Wasm module must be a regular file of at most 1 MiB");
    const buffer = Buffer.alloc(maxModuleBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > maxModuleBytes) throw Error("Wasm module exceeds 1 MiB");
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}
import path from "node:path";
import type { PluginTool } from "./plugins.js";



export interface WasmToolConfig {
  name: string;
  description: string;
  path: string;
  timeoutMs?: number;
}

export function validateWasmTools(config: WasmToolConfig[]): void {
  if (!Array.isArray(config)) throw Error("wasmTools must be an array");
  const names = new Set<string>();
  for (const item of config) {
    if (!item || typeof item.name !== "string" || item.name.length > 80 || !/^plugin_[a-z][a-z0-9_]*$/.test(item.name) || names.has(item.name) ||
        typeof item.description !== "string" || !item.description.trim() ||
        typeof item.path !== "string" || !item.path.trim() ||
        (item.timeoutMs !== undefined && (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > 30000))) throw Error("Invalid wasmTools entry");
    names.add(item.name);
  }
}

/** Files are re-read for every invocation; running instances retain their byte snapshot.
 * Worker separation permits cancellation, NOT a Node/OS memory sandbox.
 */
export function wasmTools(home: string, config: WasmToolConfig[]): PluginTool[] {
  validateWasmTools(config);
  return config.map(item => ({
    name: item.name, description: item.description,
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
    async execute(input, context) {
      if (context.signal?.aborted) throw Error("Wasm tool cancelled");
      if (typeof input.input !== "string" || Buffer.byteLength(input.input) > 65536) throw Error("Wasm input must be a string of at most 65536 bytes");
      if (activeCalls >= maxCalls) throw Error("Wasm tool capacity reached");
      activeCalls++;
      try {
        const file = await readModule(path.resolve(home, item.path));
        if (context.signal?.aborted) throw Error("Wasm tool cancelled");
        return await new Promise<string>((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./wasm-tool-worker.ts" : "./wasm-tool-worker.js", import.meta.url), {
            // --input-type applies only to eval/stdin, not a worker file entrypoint.
          ...(process.execArgv.some(arg => arg.startsWith("--input-type="))
            ? { execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type=")) } : {}),
          workerData: { bytes: file, input: input.input },
            resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
          });
          let settled = false;
          const finish = (error?: Error, result?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            context.signal?.removeEventListener("abort", abort);
            void worker.terminate().then(() => { if (error) reject(error); else resolve(result!); }, reject);
          };
          const abort = () => finish(Error("Wasm tool cancelled"));
          const timer = setTimeout(() => finish(Error("Wasm tool timed out")), item.timeoutMs ?? 5000);
          context.signal?.addEventListener("abort", abort, { once: true });
          if (context.signal?.aborted) abort();
          worker.once("message", message => message.error ? finish(Error("Wasm tool execution failed")) : finish(undefined, message.result));
          worker.once("error", () => finish(Error("Wasm worker failed")));
          worker.once("exit", () => finish(Error("Wasm worker exited without a result")));
        });
      } finally { activeCalls--; }
    },
  }));
}
