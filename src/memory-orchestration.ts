// SPDX-License-Identifier: Apache-2.0
import type { MemoryTurn } from "./memory.js";

/** Recall and capture behavior, separate from the durable memory provider API. */
export interface MemoryOrchestrator {
  recall(sessionKey: string, text: string): Promise<string>;
  capture(turn: MemoryTurn): Promise<void>;
}
export class MemoryOrchestrationRegistry implements MemoryOrchestrator {
  private readonly implementations = new Map<string, MemoryOrchestrator>();
  private selected?: MemoryOrchestrator;
  private selectedName = "none";
  get size(): number { return this.implementations.size; }
  register(name: string, implementation: MemoryOrchestrator): void {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || this.implementations.has(name) ||
        !implementation || typeof implementation.recall !== "function" || typeof implementation.capture !== "function") throw Error("Invalid or duplicate memory orchestrator");
    this.implementations.set(name, { recall: implementation.recall.bind(implementation), capture: implementation.capture.bind(implementation) });
  }
  names(): string[] { return [...this.implementations.keys()]; }
  get active(): string { return this.selectedName; }
  validate(name: string): void {
    if (name !== "none" && !this.implementations.has(name)) throw Error(`Unknown memory orchestrator: ${name}`);
  }
  select(name: string | undefined): void {
    this.validate(name ?? "none");
    if (name === undefined || name === "none") { this.selected = undefined; this.selectedName = "none"; return; }
    const selected = this.implementations.get(name);
    if (!selected) throw Error(`Unknown memory orchestrator: ${name}`);
    this.selected = selected;
    this.selectedName = name;
  }
  clear(): void { this.selected = undefined; this.selectedName = "none"; this.implementations.clear(); }
  async recall(sessionKey: string, text: string): Promise<string> { return this.selected ? this.selected.recall(sessionKey, text) : ""; }
  async capture(turn: MemoryTurn): Promise<void> { await this.selected?.capture(turn); }
}
