import { setTimeout } from "node:timers/promises";
import type { SessionObservation } from "./harness.js";

/** A read-only capability supplied by the owner, never a runtime/session handle. */
export interface SessionObserver {
  observeSession(key: string): SessionObservation | undefined;
}

/** Pull-based, coalesced snapshots, not a transcript or lossless activity log.
 * No background producer or queue: a slow reader simply sees the latest state.
 * The transport must scope keys and abort its signal on disconnect/shutdown.
 */
export async function* observeSessionChanges(owner: SessionObserver, key: string,
  signal: AbortSignal, intervalMs = 250): AsyncGenerator<SessionObservation | undefined> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60000) throw Error("Invalid observation interval");
  let previous: string | undefined;
  while (!signal.aborted) {
    const snapshot = owner.observeSession(key);
    const encoded = JSON.stringify(snapshot) ?? "null";
    if (encoded !== previous) {
      previous = encoded;
      yield snapshot;
    }
    if (signal.aborted) return;
    try { await setTimeout(intervalMs, undefined, { signal, ref: false }); }
    catch (error) { if (signal.aborted) return; throw error; }
  }
}
