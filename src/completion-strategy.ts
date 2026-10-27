import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CompletionPrompt } from "./completion-check.js";

/** Trusted startup-only advisory strategy; cannot replace host authorization checks. */
export interface CompletionStrategyModule { apiVersion: 1; prompt: CompletionPrompt }
export async function completionStrategy(home: string, module: string | undefined, baseline: CompletionStrategyModule): Promise<CompletionPrompt> {
  const selected = module ? (await import(pathToFileURL(path.resolve(home, module)).href)).default : baseline;
  if (selected?.apiVersion !== 1 || typeof selected.prompt !== "function") throw Error("Invalid completion strategy");
  return selected.prompt.bind(selected);
}
