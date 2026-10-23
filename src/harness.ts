/**
 * The agent loop. One long-running process; per conversation (session key) a FIFO
 * of inputs, processed one turn at a time. A periodic tick re-enters idle sessions
 * for heartbeats, /loop prompts and standing goals, which is what keeps the agent
 * "alive" between messages.
 */
import { randomUUID } from "node:crypto";
import type { PersistedSession } from "./state.js";
import type { Address, AgentRuntime, BusyMode, Channel, Inbound, RuntimeSession, SendMeta, TurnEvent, TurnOutcome } from "./types.js";
import { InboxLedger, idsOf, replayable } from "./delivery/inbox.js";
import { OutboxDelivery, type OutboxEntry } from "./delivery/outbox.js";
import { SeenWindow } from "./delivery/seen.js";
import { approvalPreview } from "./approval-preview.js";

export { approvalPreview };

export const NO_REPLY = "NO_REPLY";
export const GOAL_DONE = "GOAL_DONE";
export const GOAL_BLOCKED = "GOAL_BLOCKED";

export interface Recurring {
  prompt: string;
  everyMs: number;
  nextAt: number;
  paused: boolean;
  /** /loop --times N */
  remaining?: number;
}

export interface Goal {
  text: string;
  criteria: string[];
  paused: boolean;
  turns: number;
}

export interface SessionState {
  key: string;
  session?: RuntimeSession;
  opening?: Promise<RuntimeSession>;
  queue: Inbound[];
  running: boolean;
  replyTo?: Address;
  heartbeat?: Recurring;
  loop?: Recurring;
  goal?: Goal;
  /** Last user/channel input (for /retry). */
  lastInput?: Inbound;
  /** Input of the turn currently running. */
  current?: Inbound;
  /** The runtime prompt itself is in progress (narrower than `current`). */
  prompting?: boolean;
  /** The running turn was cancelled on request (API stop): finish it as cancelled. */
  cancelling?: Inbound;
  /** The turn whose runtime prompt already returned (too late to cancel). */
  prompted?: Inbound;
  /** Inputs steered into the running turn; durable until that turn completes. */
  steered?: Inbound[];
  /** Turn finished but its inbox→outbox transition is not yet saved. */
  unsaved?: boolean;
  /** Finished replies not yet delivered (persisted; retried without re-running the turn). */
  outbox: OutboxEntry[];
  lastActivity: number;
}

export type { OutboxEntry };

export interface PendingApproval {
  id: string;
  sessionKey: string;
  tool: string;
  input: unknown;
  resolve: (ok: boolean) => void;
}

export interface HarnessOptions {
  runtime: AgentRuntime;
  tickMs: number;
  busyMode: BusyMode;
  /** Max automatic goal continuation turns before the goal pauses itself. */
  goalMaxTurns?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /** Durably records a reply that can never be delivered (before it leaves the outbox). */
  parkUndeliverable?: (entry: OutboxEntry, error: string) => Promise<void>;
}

export type CommandHandler = (input: Inbound) => Promise<boolean>;

export class Harness {
  readonly sessions = new Map<string, SessionState>();
  readonly channels = new Map<string, Channel>();
  readonly approvals = new Map<string, PendingApproval>();
  paused = false;
  stopping = false;
  private halting = false;
  busyMode: BusyMode;
  home?: Address;
  /** Set by the command layer; returns true if the input was a handled command. */
  commandHandler?: CommandHandler;
  /** Called after anything that may change persistable state; resolves when written. */
  onStateChange?: () => void | Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly idle = new Set<() => void>();
  private readonly quiet = new Set<() => void>();
  /** Durable inbox bookkeeping, accepted-id window, outbox delivery (src/delivery/). */
  private readonly inbox = new InboxLedger();
  private readonly seen = new SeenWindow();
  private readonly outbox: OutboxDelivery;
  /** Shutdown chose its final inbox snapshot; late turn results are discarded. */
  private frozen = false;
  private restoredReleased = false;

  constructor(readonly opts: HarnessOptions) {
    this.busyMode = opts.busyMode;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.error(`[harness] ${m}`));
    this.outbox = new OutboxDelivery({
      deliver: (to, text, meta) => this.deliver(to, text, meta),
      park: opts.parkUndeliverable,
      save: async () => void (await this.onStateChange?.()),
      log: this.log,
    });
  }

  get runtime(): AgentRuntime {
    return this.opts.runtime;
  }

  // ---------------------------------------------------------------- lifecycle

  addChannel(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  async start(): Promise<void> {
    const pins = { pin: (ids: Iterable<string>) => this.pinSeen(ids), unpin: (ids: Iterable<string>) => this.unpinSeen(ids) };
    for (const ch of this.channels.values()) await ch.start((input) => this.accept(input), pins);
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    this.timer.unref?.();
    this.log(`running: runtime=${this.runtime.name} channels=${[...this.channels.keys()].join(",") || "none"}`);
  }

  /**
   * Graceful stop: no more ticks or channel input, finish queued work for at most
   * `drainMs`, then abort what is still running and dispose sessions.
   * Returns unfinished user/cron inputs (aborted or still queued) so the caller can
   * persist and replay them: at-least-once processing across restarts.
   */
  async stop(drainMs = 0): Promise<Inbound[]> {
    const deadline = Date.now() + Math.max(0, drainMs);
    // New channel input is refused (channels do not acknowledge it, so it is redelivered);
    // channels stay connected during the drain so replies still go out.
    this.stopping = true;
    // Pending approvals cannot survive a restart (the waiting tool call is gone): deny them;
    // the interrupted turn is replayed and asks again.
    for (const p of this.approvals.values()) p.resolve(false);
    this.approvals.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (drainMs > 0 && !this.paused) {
      // A prior transient turn/delivery failure leaves its input queued without a hot retry loop.
      // Give it one more chance while channels are still available during graceful drain.
      for (const session of this.sessions.values()) if ((session.queue.length || session.outbox.length) && !session.running) void this.pump(session);
      let t: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        this.drained().then(() => false),
        new Promise<boolean>((r) => (t = setTimeout(() => r(true), drainMs))),
      ]);
      clearTimeout(t);
      if (timedOut) this.log(`drain timeout after ${drainMs / 1000}s, aborting running turns`);
    }
    // Freeze queue advancement and retain a safe fallback before asking runtime calls to stop.
    // Abort/quiescence shares the original drain deadline, so shutdown cannot become unbounded.
    this.halting = true;
    // From here on, finishing turns record no reply (their input stays in the inbox and
    // replays), so the inbox snapshot and the outbox are always consistent.
    this.frozen = true;
    const fallback = this.pendingInputs();
    const acceptingKeys = new Set([...this.inbox.accepting].map((input) => input.sessionKey));
    const aborting = Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.running || acceptingKeys.has(session.key))
        .map((session) => Promise.resolve().then(() => session.session?.abort()).catch(() => undefined)),
    ).then(() => this.quiesced());
    const remaining = Math.max(0, deadline - Date.now());
    let quiescent = false;
    if (remaining > 0) {
      let timer: NodeJS.Timeout | undefined;
      quiescent = await Promise.race([
        aborting.then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), remaining))),
      ]);
      clearTimeout(timer);
    } else {
      void aborting;
    }
    const unfinished = quiescent ? this.pendingInputs() : fallback;
    const cleanup = [...this.sessions.values()].map((s) => {
      s.queue.length = 0;
      return Promise.resolve().then(() => s.session?.dispose()).catch(() => this.log("session cleanup failed"));
    });
    let cleanupTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(cleanup),
        new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
      ]);
    } finally { clearTimeout(cleanupTimer); }
    // Channels get what is left of the deadline (at least 2s to flush their own state).
    const budget = Math.max(2000, deadline - Date.now());
    for (const ch of this.channels.values()) await ch.stop(budget).catch((err) => this.log(`stop ${ch.name}: ${err}`));
    return unfinished;
  }

  /** Resolves when no session is running and all queues are empty. */
  async drained(): Promise<void> {
    if (this.isDrained()) return;
    await new Promise<void>((resolve) => this.idle.add(resolve));
  }

  private isDrained(): boolean {
    if (this.inbox.accepting.size) return false;
    for (const s of this.sessions.values()) if (s.running || s.queue.length || s.outbox.length || s.unsaved) return false;
    return true;
  }

  private async quiesced(): Promise<void> {
    if (!this.inbox.accepting.size && ![...this.sessions.values()].some((s) => s.running)) return;
    await new Promise<void>((resolve) => this.quiet.add(resolve));
  }

  // ---------------------------------------------------------------- sessions

  state(key: string): SessionState {
    let s = this.sessions.get(key);
    if (!s) {
      s = { key, queue: [], outbox: [], running: false, lastActivity: this.now() };
      this.sessions.set(key, s);
    }
    return s;
  }

  async sessionFor(key: string, fresh = false): Promise<RuntimeSession> {
    const s = this.state(key);
    if (fresh && s.session) {
      await s.session.dispose();
      s.session = undefined;
    }
    if (s.session) return s.session;
    s.opening ??= this.runtime.open(key, { fresh });
    try {
      s.session = await s.opening;
    } finally {
      s.opening = undefined;
    }
    return s.session;
  }

  async resetSession(key: string): Promise<void> {
    const s = this.state(key);
    if (s.running) await s.session?.abort();
    s.queue.length = 0;
    await this.sessionFor(key, true);
  }

  // ---------------------------------------------------------------- input

  /**
   * Channel entry point: resolves once the input is durably recorded (pending inbox in the
   * state file), so the channel may acknowledge it upstream. Commands run in the background.
   */
  async accept(input: Inbound): Promise<void> {
    if (this.stopping) throw new Error("shutting down");
    // Drop what was already accepted before (redelivery after a cursor rewind or crash).
    // Acknowledge a duplicate only once the state is durable (an earlier save may have failed).
    const duplicate = async () => void (await this.onStateChange?.());
    if (input.parts?.length) {
      const fresh = input.parts.filter((p) => !this.seen.has(p.id));
      if (!fresh.length) return duplicate();
      if (fresh.length < input.parts.length) input = { ...input, parts: fresh, id: fresh[0].id, text: fresh.map((p) => p.text).join("\n") };
    } else if (input.id && this.seen.has(input.id)) return duplicate();
    const ids = idsOf(input);
    for (const id of ids) this.seen.mark(id);
    this.inbox.accepting.add(input);
    let applied = false;
    try {
      // Commands complete before acknowledgement: their effect and the seen id are saved
      // together. (Commands only change state or enqueue work; none blocks for long.)
      await this.submit(input, true);
      applied = true;
      await this.outbox.barrier(); // throws if not durable → channel does not acknowledge
    } catch (err) {
      const queued = this.sessions.get(input.sessionKey)?.queue.includes(input);
      if (applied && !queued) {
        // A command already took effect (or a steered input was handed over): keep its ids
        // seen so a redelivery does not apply it twice; the next successful save records it.
        this.log(`state save failed after applying ${input.text.split(/\s/)[0]}; redelivery will be deduplicated`);
      } else {
        for (const id of ids) this.seen.unmark(id);
        this.dropQueued(input);
      }
      throw err;
    } finally {
      this.inbox.accepting.delete(input);
      this.notifyQuiet();
      const session = this.sessions.get(input.sessionKey);
      if (session?.queue.length || session?.outbox.length) void this.pump(session);
    }
  }

  static readonly SEEN_MAX = SeenWindow.MAX;
  /** Restores of one interrupted input before it is given up. */
  static readonly MAX_REPLAYS = 3;

  /** Channels pin ids of their uncommitted upstream window; unpin once the checkpoint is durable. */
  pinSeen(ids: Iterable<string>): void {
    this.seen.pin(ids);
  }

  unpinSeen(ids: Iterable<string>): void {
    this.seen.unpin(ids);
  }

  /** Remove a not-yet-started input again (acceptance failed, the channel will redeliver). */
  private dropQueued(input: Inbound): void {
    const s = this.sessions.get(input.sessionKey);
    const i = s ? s.queue.indexOf(input) : -1;
    if (i >= 0) s!.queue.splice(i, 1);
  }

  /** Persistable seen ids (a command still executing stays out: its redelivery must run it). */
  seenIds(): string[] {
    return this.seen.ids(this.inbox.inflightIds());
  }

  restoreSeen(ids: string[]): void {
    this.seen.restore(ids);
  }

  /** Persist in the background; failures are logged (used where nobody waits for durability). */
  private saveSoon(): void {
    void Promise.resolve()
      .then(() => this.onStateChange?.())
      .catch((err) => this.log(`state save failed: ${err instanceof Error ? err.message : err}`));
  }

  /**
   * Replayable inputs not yet finished (running or queued). Persisted as the inbox.
   * Commands are never part of it: they complete before the channel acknowledges them,
   * so an interrupted command is simply redelivered by the channel.
   */
  pendingInputs(): Inbound[] {
    return this.inbox.snapshot(this.sessions.values());
  }

  /**
   * Command dispatch + queueing for every input. Channels use accept() (dedup + durable ack);
   * direct callers get the same persist-before-run guarantee via enqueue().
   */
  async submit(input: Inbound, deferPump = false): Promise<void> {
    const s = this.state(input.sessionKey);
    // API runs answer to the run itself, never become the session's conversation address.
    if (input.replyTo && input.source !== "api") s.replyTo = input.replyTo;
    s.lastActivity = this.now();
    // Slash commands are a chat feature; API run input is always a turn (never privileged).
    if (input.source !== "api" && input.text.trimStart().startsWith("/") && this.commandHandler) {
      this.inbox.runningCommands.add(input);
      let handled: boolean;
      try {
        handled = await this.commandHandler(input);
      } finally {
        this.inbox.runningCommands.delete(input);
      }
      if (handled) {
        this.saveSoon();
        return;
      }
    }
    if (s.running) {
      if (this.busyMode === "steer" && s.session && s.current) {
        const turn = s.current;
        // Durable before the runtime sees it: held in `handoff` (part of every inbox snapshot)
        // until it is attached to the running turn or moved to the queue — no gap in between.
        this.inbox.handoff.add(input);
        try {
          await this.onStateChange?.();
        } catch (err) {
          this.inbox.handoff.delete(input);
          throw err;
        }
        this.inbox.handoff.delete(input);
        let steered = false;
        if (s.current === turn && s.prompting && s.session) {
          // Still the same prompt running (not just outbox flushing): steer into it.
          (s.steered ??= []).push(input);
          try {
            await s.session.steer(input.text);
            steered = true;
          } catch (err) {
            // Already durable and accepted: never fail acceptance now, run it as the next turn.
            s.steered = s.steered?.filter((x) => x !== input);
            this.log(`steer failed, queued as next turn: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (!steered) {
          // The turn ended meanwhile: run it as the next turn instead.
          s.queue.push(input);
          if (!deferPump) void this.pump(s);
        }
        return;
      }
      if (this.busyMode === "interrupt" && s.session) {
        s.queue.unshift(input);
        await s.session.abort();
        return;
      }
    }
    if (deferPump) {
      s.queue.push(input); // accept() saves the inbox, then starts the pump
      return;
    }
    this.enqueue(input); // replayable inputs start only after their inbox save
  }

  /**
   * Cancel an accepted input by id (API stop). A queued input is answered as cancelled right
   * away; a running one is aborted and finishes as cancelled. False if it is not pending.
   */
  async cancel(sessionKey: string, id: string): Promise<"queued" | "running" | false> {
    const s = this.sessions.get(sessionKey);
    if (!s) return false;
    if (s.current?.id === id && s.running) {
      if (s.cancelling === s.current) return "running";
      if (s.prompted === s.current) return false; // prompt already returned: completes normally
      s.cancelling = s.current;
      // Before the prompt (session still opening) runTurn sees `cancelling` and never starts it.
      if (s.prompting && s.session) await s.session.abort();
      return "running";
    }
    const i = s.queue.findIndex((q) => q.id === id);
    if (i < 0) return false;
    const [input] = s.queue.splice(i, 1);
    this.inbox.unsaved.delete(input!);
    if (input!.replyTo) {
      s.outbox.push(this.outbox.create(s.key, input!.replyTo, "", "cancelled"));
      s.unsaved = true;
    }
    this.saveSoon();
    void this.pump(s);
    return "queued";
  }

  /** Leave pause and continue all waiting queues in order. */
  resume(): void {
    this.paused = false;
    for (const s of this.sessions.values()) if (s.queue.length) void this.pump(s);
  }

  /**
   * Enqueue without command parsing (used by commands, cron, tick). Replayable inputs
   * (cron, API, …) only start once they are in the saved inbox; ticks are ephemeral.
   */
  enqueue(input: Inbound): void {
    const s = this.state(input.sessionKey);
    if (input.replyTo && input.source !== "api") s.replyTo ??= input.replyTo;
    s.queue.push(input);
    if (replayable(input) && this.onStateChange) {
      this.inbox.unsaved.add(input);
      void this.persistQueued();
      return;
    }
    void this.pump(s);
  }

  /** Save the inbox for queued-but-unsaved inputs, then let them run. Retried on tick. */
  private async persistQueued(): Promise<void> {
    if (!this.inbox.unsaved.size) return;
    const batch = [...this.inbox.unsaved];
    try {
      await this.onStateChange?.();
    } catch (err) {
      this.log(`inbox save failed, input held: ${err instanceof Error ? err.message : err}`);
      return;
    }
    for (const input of batch) this.inbox.unsaved.delete(input);
    const keys = new Set(batch.map((i) => i.sessionKey));
    for (const key of keys) {
      const s = this.sessions.get(key);
      if (s?.queue.length) void this.pump(s);
    }
  }

  /**
   * Restore inbox entries without executing them; startup releases them once channels are up.
   * Everything in the inbox is a turn (commands never enter a queue), so no command parsing.
   */
  /**
   * Re-queue the persisted inbox. An input whose turn was running when the process died counts
   * one replay; one that keeps killing the process (e.g. OOM) is given up after `maxReplays`
   * with a failed reply instead of crash-looping. Queued inputs that never ran are not charged.
   * The caller persists the counters before releasing the inputs.
   */
  restorePending(inputs: Inbound[], maxReplays = Harness.MAX_REPLAYS): void {
    for (const input of inputs) {
      if (input.started) input.replays = (input.replays ?? 0) + 1;
      input.started = undefined;
      const s = this.state(input.sessionKey);
      if ((input.replays ?? 0) > maxReplays) {
        const attempts = input.replays;
        this.log(`giving up on input in ${s.key} after ${attempts} interrupted attempts`);
        const dest = input.replyTo ?? (input.source === "cron" ? undefined : (s.replyTo ?? this.home));
        if (dest) {
          this.outbox.held = true; // like restored replies: sent once channels are ready
          s.outbox.push(this.outbox.create(s.key, dest, `⚠️ Turn abandoned: it was interrupted ${attempts} times (restart or out of memory).`, "failed"));
        }
        continue;
      }
      s.queue.push(input);
      this.inbox.restored.add(input);
    }
  }

  releaseRestored(): void {
    this.inbox.restored.clear();
    this.outbox.held = false;
    for (const s of this.sessions.values()) if (s.queue.length || s.outbox.length) void this.pump(s);
  }

  /** Undelivered replies, persisted with the state. */
  outboxEntries(): OutboxEntry[] {
    return [...this.sessions.values()].flatMap((s) => s.outbox);
  }

  restoreOutbox(entries: OutboxEntry[]): void {
    if (!entries.length) return;
    this.outbox.held = true;
    for (const e of entries) this.state(e.sessionKey).outbox.push(e);
  }

  private async pump(s: SessionState): Promise<void> {
    if (s.running) return;
    s.running = true;
    try {
      while (!this.halting) {
        // A finished turn's reply goes out only once its completion is durable.
        if (s.unsaved) {
          try {
            await this.onStateChange?.();
            s.unsaved = false;
          } catch (err) {
            this.log(`state save failed, reply held: ${err instanceof Error ? err.message : err}`);
            break;
          }
        }
        // Replies of finished turns go out first (FIFO) and are never recomputed.
        if (!(await this.outbox.flush(s.key, s.outbox))) break;
        if (!s.queue.length || this.paused) break;
        const input = s.queue[0]!;
        // Not yet durable (acceptance/inbox save pending) or restored before channels are ready.
        if (this.inbox.held(input)) break;
        s.queue.shift();
        if (input.source === "channel" || input.source === "api") s.lastInput = input;
        s.current = input;
        if (replayable(input)) {
          // Durable before the turn runs, so a crash during it is charged to this input.
          input.started = true;
          let saved = true;
          await Promise.resolve(this.onStateChange?.()).catch((err) => {
            saved = false;
            this.log(`state save failed, turn held: ${err instanceof Error ? err.message : err}`);
          });
          // Not durable: do not run it (a crash would go uncounted); the tick retries.
          if (!saved || this.halting) {
            input.started = undefined;
            s.current = undefined;
            s.queue.unshift(input);
            break;
          }
        }
        try {
          await this.runTurn(s, input);
        } catch (err) {
          // Turn did not finish (aborted on shutdown): keep it and what was steered into it, in order.
          s.current = undefined;
          s.queue.unshift(input, ...(s.steered ?? []));
          s.steered = undefined;
          await Promise.resolve(this.onStateChange?.()).catch((saveErr) =>
            this.log(`state save failed after turn failure: ${saveErr instanceof Error ? saveErr.message : saveErr}`),
          );
          this.log(`turn retained in inbox for retry: ${err instanceof Error ? err.message : err}`);
          break;
        }
        // Finished: never re-run. Input (and steered follow-ups) leave the inbox, the reply
        // is in the outbox; the next loop iteration saves that transition before sending.
        s.current = undefined;
        s.steered = undefined;
        s.unsaved = true;
      }
    } finally {
      s.running = false;
      this.notifyQuiet();
    }
  }

  /** Single place for lifecycle wake-ups: quiescence (stop) and full drain (drained()). */
  private notifyQuiet(): void {
    if (this.inbox.accepting.size || [...this.sessions.values()].some((session) => session.running)) return;
    for (const resolve of [...this.quiet]) (this.quiet.delete(resolve), resolve());
    if (this.isDrained()) for (const r of [...this.idle]) (this.idle.delete(r), r());
  }

  private async runTurn(s: SessionState, input: Inbound): Promise<void> {
    let reply: string;
    let outcome: TurnOutcome | undefined;
    const to = input.replyTo ?? (input.source === "cron" ? undefined : s.replyTo);
    const typingCh = to ? this.channels.get(to.channel) : undefined;
    await typingCh?.typing?.(to!, true).catch(() => undefined);
    const onEvent = typingCh?.turnEvent
      ? (event: TurnEvent) => {
          try {
            typingCh.turnEvent!(to!, event);
          } catch {
            // progress is best effort
          }
        }
      : undefined;
    try {
      const session = await this.sessionFor(s.key);
      const text = input.replyOptional
        ? `${input.text}\n\n(Not addressed to you directly. Reply only if you have something useful to add; otherwise reply exactly ${NO_REPLY}.)`
        : input.text;
      if (s.cancelling === input) {
        reply = ""; // stopped while the session was opening: never started
      } else {
        s.prompting = true;
        try {
          reply = (await session.prompt(text, { ...input.turn, onEvent })).trim();
        } finally {
          s.prompting = false;
          s.prompted = input;
        }
      }
    } catch (err) {
      if (this.halting) throw err;
      reply = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
      outcome = "failed";
      if (s.cancelling !== input) this.log(`turn failed in ${s.key}: ${reply}`);
    } finally {
      await typingCh?.typing?.(to!, false).catch(() => undefined);
    }
    s.prompted = undefined;
    if (s.cancelling === input) {
      s.cancelling = undefined;
      if (!this.frozen) outcome = "cancelled";
      if (outcome === "cancelled" && reply.startsWith("⚠️")) reply = "";
    }
    if (this.frozen) throw new Error("shut down after inbox snapshot; input will replay");
    s.lastActivity = this.now();
    if (s.goal && input.source === "goal") {
      s.goal.turns++;
      if (reply.includes(GOAL_DONE)) {
        const done = s.goal.text;
        s.goal = undefined;
        reply = reply.replaceAll(GOAL_DONE, "").trim() || `✅ Goal achieved: ${done}`;
      } else if (reply.includes(GOAL_BLOCKED)) {
        s.goal.paused = true;
        reply = `${reply.replaceAll(GOAL_BLOCKED, "").trim()}\n\n⏸️ Goal paused (blocked). /goal resume to continue.`;
      } else if (s.goal.turns >= (this.opts.goalMaxTurns ?? 20)) {
        s.goal.paused = true;
        reply += `\n\n⏸️ Goal paused after ${s.goal.turns} turns. /goal resume to continue.`;
      }
    }
    // An API run always gets its result (even empty): that is how the run finishes.
    if (input.source === "api" && input.replyTo) {
      s.outbox.push(this.outbox.create(s.key, input.replyTo, reply === NO_REPLY ? "" : reply, outcome));
      return;
    }
    if (!reply || reply === NO_REPLY) return;
    if (input.source === "cron" && !input.replyTo) {
      this.log(`[${s.key}] ${reply.slice(0, 500)}`); // deliver: local
      return;
    }
    const dest = input.replyTo ?? s.replyTo ?? this.home;
    if (!dest) {
      this.log(`no address for reply, handled locally: ${reply.slice(0, 80)}`);
      return;
    }
    // Recorded together with the turn's completion; pump delivers it (and retries on failure).
    s.outbox.push(this.outbox.create(s.key, dest, reply));
  }

  /**
   * Reply to an input through the durable outbox (command acknowledgements). For an input being
   * accepted, the reply is saved together with the command's effect and seen id, and delivered
   * (with retries, never re-running the command) once that save succeeded.
   */
  post(input: Inbound, text: string): void {
    const s = this.state(input.sessionKey);
    const dest = input.replyTo ?? s.replyTo ?? this.home;
    if (!dest) {
      this.log(`no address for reply, handled locally: ${text.slice(0, 80)}`);
      return;
    }
    const entry = this.outbox.create(s.key, dest, text);
    s.outbox.push(entry);
    // Persistence barrier: no flush path sends it before a save that includes the command's
    // effect. accept() awaits that save itself; other callers get it here (tick retries).
    this.outbox.block(entry);
    if (this.inbox.accepting.has(input)) return;
    void this.outbox.barrier()
      .then(() => this.pump(s))
      .catch((err) => this.log(`state save failed: ${err instanceof Error ? err.message : err}`));
  }

  async deliver(to: Address | undefined, text: string, meta?: SendMeta): Promise<void> {
    const target = to ?? this.home;
    if (!target) {
      this.log(`no address for reply, handled locally: ${text.slice(0, 80)}`);
      return;
    }
    const ch = this.channels.get(target.channel);
    if (!ch) throw new Error(`unknown channel ${target.channel}`);
    await ch.send(target, text, meta);
  }

  // ---------------------------------------------------------------- loop tick

  /** Re-enter idle sessions: heartbeat, /loop, standing goal. Public for tests. */
  async tick(at = this.now()): Promise<void> {
    // Retry loop for undelivered replies / unsaved completions (homeserver or disk back),
    // independent of new input; the tick interval (default 15s) is the backoff. Also while paused.
    if (this.inbox.unsaved.size) void this.persistQueued();
    // Command replies whose acceptance save failed: retry the save, never re-run the command.
    if (this.outbox.hasBlocked && !this.inbox.accepting.size) {
      await this.outbox.barrier().catch((err) => this.log(`state save failed: ${err instanceof Error ? err.message : err}`));
    }
    if (!this.halting && !this.outbox.held) {
      // Queued turns too: one held back by a failed start checkpoint runs once the disk is back.
      for (const s of this.sessions.values()) if (!s.running && (s.outbox.length || s.unsaved || s.queue.length)) void this.pump(s);
    }
    if (this.paused) return;
    for (const s of this.sessions.values()) {
      if (s.running || s.queue.length || s.outbox.length || s.unsaved) continue;
      if (s.loop && !s.loop.paused && at >= s.loop.nextAt) {
        s.loop.nextAt = at + s.loop.everyMs;
        if (s.loop.remaining !== undefined && --s.loop.remaining <= 0) {
          const prompt = s.loop.prompt;
          s.loop = undefined;
          this.enqueue({ sessionKey: s.key, text: prompt, source: "loop" });
        } else {
          this.enqueue({ sessionKey: s.key, text: s.loop.prompt, source: "loop" });
        }
        continue;
      }
      if (s.heartbeat && !s.heartbeat.paused && at >= s.heartbeat.nextAt) {
        s.heartbeat.nextAt = at + s.heartbeat.everyMs;
        this.enqueue({
          sessionKey: s.key,
          text: `${s.heartbeat.prompt}\n\n(Heartbeat. If there is nothing worth saying, reply exactly ${NO_REPLY}.)`,
          source: "heartbeat",
        });
        continue;
      }
      if (s.goal && !s.goal.paused) {
        this.enqueue({ sessionKey: s.key, text: goalPrompt(s.goal), source: "goal" });
      }
    }
    this.saveSoon();
  }

  // ---------------------------------------------------------------- persistence

  /** Sessions worth persisting (anything beyond a bare conversation). */
  snapshotSessions(): PersistedSession[] {
    const out: PersistedSession[] = [];
    for (const s of this.sessions.values()) {
      if (!s.heartbeat && !s.loop && !s.goal && !s.replyTo) continue;
      out.push({ key: s.key, replyTo: s.replyTo, heartbeat: s.heartbeat, loop: s.loop, goal: s.goal });
    }
    return out;
  }

  restoreSessions(list: PersistedSession[]): void {
    for (const p of list) {
      const s = this.state(p.key);
      s.replyTo = p.replyTo;
      s.heartbeat = p.heartbeat;
      s.loop = p.loop;
      s.goal = p.goal;
    }
  }

  // ---------------------------------------------------------------- approvals

  /** Bridge for the runtime's approval hook. Asks in the conversation and waits for /approve or /deny. */
  requestApproval = async (sessionKey: string, tool: string, input: unknown): Promise<boolean> => {
    const id = randomUUID().slice(0, 8);
    const s = this.state(sessionKey);
    const preview = approvalPreview(tool, input);
    let settled = false;
    const result = new Promise<boolean>((resolve) =>
      this.approvals.set(id, { id, sessionKey, tool, input, resolve: (ok) => ((settled = true), resolve(ok)) }),
    );
    // Not via the session outbox (its pump is waiting for this very approval). Same delivery id
    // on every retry, so a prompt that arrived despite an error is not posted twice.
    const text = `🔐 Approval needed [${id}]: \`${tool}\` ${preview}\n/approve ${id} or /deny ${id} (or react ✅/❌)`;
    for (let attempt = 1; !settled; attempt++) {
      try {
        await this.deliver(s.replyTo, text, { approvalId: id, deliveryId: `approval-${id}` });
        break;
      } catch (err) {
        if (attempt >= Harness.APPROVAL_SEND_ATTEMPTS || this.stopping) {
          this.log(`approval prompt ${id} undeliverable, denying: ${err instanceof Error ? err.message : err}`);
          this.approvals.get(id)?.resolve(false);
          this.approvals.delete(id);
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(30_000, Harness.APPROVAL_RETRY_MS * 2 ** (attempt - 1))));
      }
    }
    return result;
  };

  static APPROVAL_SEND_ATTEMPTS = 8;
  static APPROVAL_RETRY_MS = 1000;
}

export function goalPrompt(goal: Goal): string {
  const criteria = goal.criteria.length ? `\nAdditional criteria:\n${goal.criteria.map((c) => `- ${c}`).join("\n")}` : "";
  return [
    `Standing goal: ${goal.text}${criteria}`,
    `Continue working toward it. When it is fully achieved, include ${GOAL_DONE} in your reply.`,
    `If you are blocked and need the user, say briefly what you need and include ${GOAL_BLOCKED}.`,
  ].join("\n");
}
