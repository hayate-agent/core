import type { Inbound } from "./types.js";

/** Generic durable-output extension. Host owns settlement/delivery and authority;
 * implementations own retention, context projection and processing policy. */
export interface ReportProcessing {
  record(input: Inbound, output: string): Promise<void>;
  context(input: Inbound): Promise<string>;
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export class ReportProcessingRegistry {
  private selected?: ReportProcessing;
  private stopping?: Promise<void>;
  private readonly implementations = new Map<string, ReportProcessing>();
  get size(): number { return this.implementations.size; }
  clear(): void { this.selected = undefined; this.implementations.clear(); }
  register(name: string, implementation: ReportProcessing): void {
    if (this.stopping) throw Error("Report processors stopping");
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || this.implementations.has(name) ||
        !implementation || [implementation.record, implementation.context, implementation.tick, implementation.stop].some(f => typeof f !== "function")) throw Error("Invalid or duplicate report processor");
    this.implementations.set(name, implementation);
  }
  select(name: string): void {
    const implementation = this.implementations.get(name);
    if (!implementation) throw Error("Unknown report processor");
    this.selected = implementation;
  }
  async record(input: Inbound, output: string): Promise<void> {
    if (!this.selected) throw Error("No report processor selected");
    await this.selected.record(input, output);
  }
  async context(input: Inbound): Promise<string> { return await this.selected?.context(input) ?? ""; }
  async tick(): Promise<void> { await this.selected?.tick(); }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const implementations = [...this.implementations.values()]; this.selected = undefined;
    this.stopping = (async () => {
      const errors: unknown[] = [];
      for (const implementation of implementations.reverse()) {
        try { await implementation.stop(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Report processor cleanup failed");
    })();
    return this.stopping;
  }
}
