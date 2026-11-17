import { randomUUID } from "node:crypto";
import { labelOutput } from "../hashtags.js";
import { type Address, PermanentDeliveryError, type SendMeta, type TurnOutcome } from "../types.js";

export interface OutboxEntry {
  /** Stable across retries and restarts (idempotent delivery). */
  id?: string;
  sessionKey: string;
  to: Address;
  text: string;
  outputTags?: string[];
  outcome?: TurnOutcome;
  maintenance?: SendMeta["maintenance"];
  progressId?: string;
  /** Routine status uses a stable update row, not a final reply. */
  statusKey?: string;
}

export interface OutboxDeps {
  deliver: (to: Address, text: string, meta: SendMeta) => Promise<void>;
  /** Durably records a reply that can never be delivered (before it leaves the outbox). */
  park?: (entry: OutboxEntry, error: string) => Promise<void>;
  /** Durable state write; throws if not durable. */
  save: () => Promise<void>;
  log: (msg: string) => void;
  /** Clock for rate-limit backoff (tests). */
  now?: () => number;
}

/** Server-requested wait (Matrix `retry_after_ms`) from a failed delivery; undefined if none. */
export function retryAfterMs(err: unknown): number | undefined {
  const m = /"retry_after_ms"\s*:\s*(\d{1,9})\b/.exec(err instanceof Error ? err.message : String(err));
  return m ? Math.min(Number(m[1]), 60_000) : undefined;
}

/**
 * Delivery side of the durable outbox. Entries live in each session's `outbox` array (persisted
 * with the state); this owns the rules for sending them:
 * - FIFO per session, stable delivery ids (channels derive idempotency keys from them),
 * - transient failures keep the entry (retried by the caller), permanent ones are parked,
 * - a persistence barrier: blocked entries (command replies whose effect is not yet saved)
 *   are never sent before the save that covers them,
 * - `held` keeps restored entries back until channels are ready.
 */
export class OutboxDelivery {
  held = false;
  /** Per-session earliest next attempt after a rate-limit; entries stay queued meanwhile. */
  private readonly notBefore = new Map<string, number>();
  private readonly blocked = new Set<OutboxEntry>();

  constructor(private readonly deps: OutboxDeps) {}

  create(sessionKey: string, to: Address, text: string, outcome?: TurnOutcome, outputTags?: string[]): OutboxEntry {
    return { id: randomUUID(), sessionKey, to, text, outputTags: structuredClone(outputTags), ...(outcome ? { outcome } : {}) };
  }

  block(entry: OutboxEntry): void {
    this.blocked.add(entry);
  }

  get hasBlocked(): boolean {
    return this.blocked.size > 0;
  }

  /** Save, then release the blocked entries covered by that snapshot. */
  async barrier(): Promise<void> {
    const covered = [...this.blocked];
    await this.deps.save();
    for (const e of covered) this.blocked.delete(e);
  }

  /** Deliver pending replies in order; false if one could not go out (it stays for a retry). */
  async flush(sessionKey: string, outbox: OutboxEntry[]): Promise<boolean> {
    while (outbox.length) {
      if (this.held) return false;
      if ((this.notBefore.get(sessionKey) ?? 0) > (this.deps.now ?? Date.now)()) return false;
      const entry = outbox[0]!;
      if (this.blocked.has(entry)) return false;
      try {
        entry.id ??= randomUUID();
        await this.deps.deliver(entry.to, labelOutput(entry.text, entry.to.channel === "dispatch" ? undefined : entry.outputTags), { deliveryId: entry.id, ...(entry.statusKey ? { statusKey: entry.statusKey } : {}), ...(entry.progressId ? { progressId: entry.progressId } : {}), ...(entry.outcome ? { outcome: entry.outcome } : {}), ...(entry.maintenance ? { maintenance: entry.maintenance } : {}) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const wait = retryAfterMs(err);
        if (wait !== undefined) this.notBefore.set(sessionKey, (this.deps.now ?? Date.now)() + wait + 250);
        if (!(err instanceof PermanentDeliveryError) || !this.deps.park) {
          this.deps.log(`reply delivery failed in ${sessionKey}, kept in outbox: ${message}`);
          return false;
        }
        try {
          await this.deps.park(entry, message);
        } catch (parkErr) {
          this.deps.log(`reply undeliverable in ${sessionKey} and parking failed, kept in outbox: ${parkErr}`);
          return false;
        }
        this.deps.log(`reply undeliverable in ${sessionKey}, parked: ${message}`);
      }
      outbox.shift();
      this.notBefore.delete(sessionKey);
      void this.deps.save().catch((err) => this.deps.log(`state save failed: ${err instanceof Error ? err.message : err}`));
    }
    return true;
  }
}
