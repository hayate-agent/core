import { randomUUID } from "node:crypto";
import { type Address, PermanentDeliveryError, type SendMeta, type TurnOutcome } from "../types.js";

export interface OutboxEntry {
  /** Stable across retries and restarts (idempotent delivery). */
  id?: string;
  sessionKey: string;
  to: Address;
  text: string;
  outcome?: TurnOutcome;
}

export interface OutboxDeps {
  deliver: (to: Address, text: string, meta: SendMeta) => Promise<void>;
  /** Durably records a reply that can never be delivered (before it leaves the outbox). */
  park?: (entry: OutboxEntry, error: string) => Promise<void>;
  /** Durable state write; throws if not durable. */
  save: () => Promise<void>;
  log: (msg: string) => void;
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
  private readonly blocked = new Set<OutboxEntry>();

  constructor(private readonly deps: OutboxDeps) {}

  create(sessionKey: string, to: Address, text: string, outcome?: TurnOutcome): OutboxEntry {
    return { id: randomUUID(), sessionKey, to, text, ...(outcome ? { outcome } : {}) };
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
      const entry = outbox[0]!;
      if (this.blocked.has(entry)) return false;
      try {
        entry.id ??= randomUUID();
        await this.deps.deliver(entry.to, entry.text, { deliveryId: entry.id, ...(entry.outcome ? { outcome: entry.outcome } : {}) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
      void this.deps.save().catch((err) => this.deps.log(`state save failed: ${err instanceof Error ? err.message : err}`));
    }
    return true;
  }
}
