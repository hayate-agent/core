import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginTool, PluginModule } from "./plugins.js";

export function wasmToolsPlugin(home: string, config: WasmToolConfig[]): PluginModule {
  return { apiVersion: 1, activate(api) { for (const tool of wasmTools(home, config)) api.registerTool(tool); } };
}

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
    if (!item || !/^plugin_[a-z][a-z0-9_]*$/.test(item.name) || names.has(item.name) ||
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
      const file = await readFile(path.resolve(home, item.path));
      if (file.byteLength > 1048576) throw Error("Wasm module exceeds 1 MiB");
      if (context.signal?.aborted) throw Error("Wasm tool cancelled");
      return new Promise<string>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./wasm-tool-worker.ts" : "./wasm-tool-worker.js", import.meta.url), {
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
    },
  }));
}
