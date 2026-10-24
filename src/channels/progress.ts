import type { TurnEvent } from "../types.js";

export type ProgressMode = "off" | "reduced" | "full";
export function progressMode(value = "off"): ProgressMode {
  if (value === "off" || value === "reduced" || value === "full") return value;
  throw new Error("Progress mode must be off, reduced or full");
}

/** Ephemeral, bounded telemetry; never blocks the durable reply pipeline. */
export class GatewayProgress {
  private pending: string[] = [];
  private scheduled?: NodeJS.Timeout;
  private sending: Promise<void> = Promise.resolve();
  private count = 0;
  private tools = new Set<string>();
  constructor(private mode: ProgressMode, private send: (text: string) => Promise<void>) {}
  event(event: TurnEvent): void {
    if (this.mode === "off" || event.type !== "tool" || this.count >= 50) return;
    if (this.mode === "reduced") {
      if (event.phase !== "start" || this.tools.has(event.name)) return;
      this.tools.add(event.name);
      this.pending.push(`Working: ${event.name}`);
    } else {
      this.pending.push(`${event.phase === "start" ? "▶" : event.error ? "⚠" : "✓"} ${event.name}${event.detail ? `\n${event.detail.slice(0, 2000)}` : ""}`);
    }
    this.count++;
    if (!this.scheduled) this.scheduled = setTimeout(() => { this.scheduled = undefined; this.flush(); }, 1500);
  }
  private flush(): void {
    if (!this.pending.length) return;
    const text = this.pending.splice(0).join("\n\n").slice(0, 8000);
    this.sending = this.sending.then(() => this.send(text)).catch(() => undefined);
  }
  async finish(): Promise<void> {
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    this.flush();
    await this.sending;
  }
}
