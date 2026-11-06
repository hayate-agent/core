import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CompletionPrompt } from "./completion-check.js";
import { PureStrategy, type StrategySelection } from "./pure-strategy.js";

/** Trusted advisory strategy; cannot replace host authorization checks. */
export interface CompletionStrategyModule { apiVersion: 1; prompt: CompletionPrompt }
export function validateCompletionStrategy(value: unknown): CompletionPrompt {
  const selected = value as CompletionStrategyModule;
  if (selected?.apiVersion !== 1 || typeof selected.prompt !== "function") throw Error("Invalid completion strategy");
  return selected.prompt.bind(selected);
}

export async function completionStrategyHolder(home: string, module: string | undefined,
  baseline: CompletionStrategyModule, overlay: StrategySelection): Promise<PureStrategy<CompletionPrompt>> {
  // Capture the installation selection once, including any configured module receiver.
  const prompt = await completionStrategy(home, module, baseline);
  const holder = new PureStrategy(home, { apiVersion: 1, prompt }, validateCompletionStrategy);
  if (overlay !== undefined) await holder.change(overlay, async () => {});
  return holder;
}
export async function completionStrategy(home: string, module: string | undefined, baseline: CompletionStrategyModule): Promise<CompletionPrompt> {
  const selected = module ? (await import(pathToFileURL(path.resolve(home, module)).href)).default : baseline;
  return validateCompletionStrategy(selected);
}
