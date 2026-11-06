// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ImprovementPolicy, NightState } from "./improvement.js";
import type { ExperimentReceipt } from "./improvement-receipt.js";
import { PureStrategy } from "./pure-strategy.js";

/** Strategy can update experiment conclusions, never host turn reservations or deadlines. */
export type NightlyProgress = Pick<NightState, "experiments" | "recentHypotheses" | "noExperimentTurns" | "done" | "results">;
export interface NightlyStrategy {
  apiVersion: 1;
  prompt(policy: ImprovementPolicy, turn: number): string;
  completed(state: NightlyProgress, reply: string): void;
  receipts(reply: string): ExperimentReceipt[];
  unique(receipts: ExperimentReceipt[]): ExperimentReceipt[];
  report(state: { night: string; turns: number; noExperimentTurns?: number }, timezone: string, receipts: ExperimentReceipt[], artifact: string): string;
}
/** Captures installation code once. Applying a local overlay requires a controller
 * reservation; do not apply one blindly before reconciling an unfinished night. */
export async function nightlyStrategyHolder(home: string, module: string | undefined,
  baseline: NightlyStrategy): Promise<PureStrategy<NightlyStrategy>> {
  return new PureStrategy(home, await nightlyStrategy(home, module, baseline), validateNightlyStrategy);
}

export async function nightlyStrategy(home: string, module: string | undefined, baseline: NightlyStrategy): Promise<NightlyStrategy> {
  const selected = module ? (await import(pathToFileURL(path.resolve(home, module)).href)).default : baseline;
  return validateNightlyStrategy(selected);
}

export function validateNightlyStrategy(value: unknown): NightlyStrategy {
  const selected = value as NightlyStrategy;
  if (selected?.apiVersion !== 1 || ["prompt", "completed", "receipts", "unique", "report"].some(key => typeof selected[key as keyof NightlyStrategy] !== "function")) throw Error("Invalid nightly strategy");
  return { apiVersion: 1, prompt: selected.prompt.bind(selected), completed: selected.completed.bind(selected),
    receipts: selected.receipts.bind(selected), unique: selected.unique.bind(selected), report: selected.report.bind(selected) };
}
