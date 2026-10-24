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
  private active = new Map<string, number>();
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  constructor(private mode: ProgressMode, private send: (text: string) => Promise<void>, private heartbeatMs = 15000) {
    if (mode !== "off") {
      this.heartbeat = setInterval(() => {
        if (this.closed || !this.active.size) return;
        const now = Date.now();
        this.pending.push([...this.active].map(([name, since]) => `⏳ ${name} läuft weiterhin (${Math.floor((now - since) / 1000)} s); noch kein Ergebnis.`).join("\n"));
        this.flush();
      }, heartbeatMs);
      this.heartbeat.unref?.();
    }
  }
  event(event: TurnEvent): void {
    if (this.closed || this.mode === "off" || event.type !== "tool") return;
    if (event.phase === "start") {
      if (this.active.size < 50) this.active.set(event.name, Date.now());
    } else this.active.delete(event.name);
    if (this.count >= 50) return;
    if (this.mode === "reduced") {
      this.pending.push(event.phase === "start" ? `▶ ${event.name} gestartet` : `${event.error ? "⚠" : "✓"} ${event.name} beendet`);
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
    this.closed = true;
    clearInterval(this.heartbeat);
    this.active.clear();
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    this.flush();
    await this.sending;
  }
}
