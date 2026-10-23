import type { Inbound } from "../types.js";

/** User, API and cron inputs are replayed after a crash; heartbeat/loop/goal ticks regenerate. */
export function replayable(i: Inbound): boolean {
  return i.source === "channel" || i.source === "api" || i.source === "cron";
}

/** The parts of a session the inbox snapshot is built from. */
export interface InboxSession {
  current?: Inbound;
  steered?: Inbound[];
  queue: Inbound[];
}

/**
 * Bookkeeping of the durable inbox: which inputs are between "known" and "safe to run".
 * Every set here is part of the snapshot, so no input is ever outside of what gets saved.
 */
export class InboxLedger {
  /** Channel inputs whose command handling or initial durable save has not completed. */
  readonly accepting = new Set<Inbound>();
  /** Restored inbox items cannot execute until startup explicitly releases them. */
  readonly restored = new Set<Inbound>();
  /** Steering inputs between durable save and attachment to a turn / the queue. */
  readonly handoff = new Set<Inbound>();
  /** Queued replayable inputs (cron, API, command-created) whose inbox save is pending. */
  readonly unsaved = new Set<Inbound>();
  /** Commands currently executing: neither acknowledged nor in the inbox. */
  readonly runningCommands = new Set<Inbound>();

  /** Not yet durable, or restored before channels are ready: must not start. */
  held(input: Inbound): boolean {
    return this.accepting.has(input) || this.unsaved.has(input) || this.restored.has(input);
  }

  /** Ids of running commands; kept out of the persisted seen window so a crash redelivers them. */
  inflightIds(): Set<string> {
    const out = new Set<string>();
    for (const input of this.runningCommands) for (const id of idsOf(input)) out.add(id);
    return out;
  }

  /**
   * Replayable inputs not yet finished (running, steered or queued): the persisted inbox.
   * Commands are never part of it: they complete before the channel acknowledges them.
   */
  snapshot(sessions: Iterable<InboxSession>): Inbound[] {
    const out: Inbound[] = [];
    const added = new Set<Inbound>();
    const add = (input: Inbound) => {
      if (replayable(input) && !added.has(input)) (added.add(input), out.push(input));
    };
    for (const input of this.handoff) add(input);
    for (const s of sessions) {
      if (s.current) add(s.current);
      for (const input of s.steered ?? []) add(input);
      for (const input of s.queue) add(input);
    }
    return out;
  }
}

export function idsOf(input: Inbound): string[] {
  return input.parts?.map((p) => p.id) ?? (input.id ? [input.id] : []);
}
