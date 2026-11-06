import type { PluginModule } from "./plugins.js";
import { wasmTools, type WasmToolConfig } from "./wasm-tools.js";
export function wasmToolsPlugin(home: string, config: WasmToolConfig[]): PluginModule {
  return { apiVersion: 1, activate(api) { for (const tool of wasmTools(home, config)) api.registerTool(tool); } };
}
