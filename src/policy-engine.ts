// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PolicyRegistry, type Policy } from "./policies.js";
import type { PluginModule } from "./plugins.js";
import type { AssessmentBackend } from "./assessment-backend.js";
import type { Address, Inbound } from "./types.js";

/** Trusted startup composition: one selection supplies both hooks and operator/model APIs. */
export interface PolicyEngineContext {
  home: string; cwd: string; config: unknown; backend: AssessmentBackend;
  reviewExecution?: import("./review-execution.js").DedicatedReviewExecution;
  notify(sessionKey: string, message: string, origin?: Address): Promise<void>;
  origin(input: Inbound): Address | undefined;
}
export interface PolicyEngine {
  policies: Policy[];
  plugins: PluginModule[];
  required: string[];
  instructions: string;
}
export interface PolicyEngineModule {
  apiVersion: 1;
  modelTools: string[];
  create(context: PolicyEngineContext): Promise<PolicyEngine> | PolicyEngine;
}
export async function loadPolicyEngine(home: string, module: string | undefined, baseline: PolicyEngineModule): Promise<PolicyEngineModule> {
  const selected = module ? (await import(pathToFileURL(path.resolve(home, module)).href)).default : baseline;
  if (selected?.apiVersion !== 1 || typeof selected.create !== "function" || !Array.isArray(selected.modelTools) ||
      selected.modelTools.some((name: unknown) => typeof name !== "string" || !/^plugin_[a-z0-9_]+$/.test(name))) throw Error("Invalid policy engine module");
  return { apiVersion: 1, modelTools: [...selected.modelTools], create: selected.create.bind(selected) };
}
export async function createPolicyEngine(module: PolicyEngineModule, context: PolicyEngineContext): Promise<PolicyEngine> {
  const engine = await module.create(context);
  if (!engine || !Array.isArray(engine.policies) || !Array.isArray(engine.plugins) || !Array.isArray(engine.required) ||
      engine.required.some(id => typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) || typeof engine.instructions !== "string" ||
      engine.required.some(id => !engine.policies.some(policy => policy.id === id))) throw Error("Invalid policy engine composition");
  const validation = new PolicyRegistry(engine.required);
  for (const policy of engine.policies) validation.register(policy);
  validation.assertReady();
  if (engine.plugins.some(plugin => plugin?.apiVersion !== 1 || typeof plugin.activate !== "function")) throw Error("Invalid policy engine plugin");
  return engine;
}
