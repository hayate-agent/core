import { Cron } from "croner";
import type { ExperimentReceipt } from "./improvement-receipt.js";
import type { NightlyStrategy } from "./nightly-strategy.js";
import type { PureStrategy, StrategySelection } from "./pure-strategy.js";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { writeFileDurable } from "./durable.js";
import { ExperimentEvaluator, type ExperimentSpec } from "./improvement-experiments.js";
import type { Harness } from "./harness.js";
import type { Address, Inbound } from "./types.js";

export interface NightlyClosureRequest {
  signal: AbortSignal;
  /** Host-owned end of this authorized work window, including timezone/DST. */
  expiresAt: number;
  input: Inbound;
  reply: string;
  night: string;
  turn: number;
  maxTurns: number;
  experiments: ExperimentReceipt[];
}
export type NightlyCompletionValidator = (request: NightlyClosureRequest) => Promise<Inbound["continuation"]>;

export interface ImprovementPolicy {
  enabled: boolean;
  startHour: number;
  endHour: number;
  maxTurns: number;
  timezone: string;
  reportTo?: Address;
  pullRequest: boolean;
  merge: boolean;
  evaluator?: { runner: string; sha256: string };
}
export function improvementPolicy(input: Partial<ImprovementPolicy> = {}): ImprovementPolicy {
  const p = { enabled: true, startHour: 23, endHour: 5, maxTurns: 20, timezone: "UTC", pullRequest: false, merge: false, ...input };
  for (const key of ["enabled", "pullRequest", "merge"] as const) if (typeof p[key] !== "boolean") throw Error(`Invalid improvement.${key}`);
  if (p.evaluator && (!path.isAbsolute(p.evaluator.runner) || !/^[a-f0-9]{64}$/.test(p.evaluator.sha256))) throw Error("Invalid improvement evaluator");
  if (p.merge && !p.pullRequest) throw Error("Improvement merge requires pullRequest");
  for (const h of [p.startHour, p.endHour]) if (!Number.isInteger(h) || h < 0 || h > 23) throw Error("Invalid improvement hours");
  if (p.startHour === p.endHour || !Number.isInteger(p.maxTurns) || p.maxTurns < 1 || p.maxTurns > 1000) throw Error("Invalid improvement budget/window");
  new Intl.DateTimeFormat("en-GB", { timeZone: p.timezone }).format();
  if (p.reportTo && (typeof p.reportTo.channel !== "string" || !p.reportTo.channel || typeof p.reportTo.target !== "string" || !p.reportTo.target)) throw Error("Invalid improvement reportTo");
  return p;
}
export function improvementWindow(now: number, p: ImprovementPolicy): { night: string; active: boolean } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: p.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find((v) => v.type === type)!.value;
  const hour = Number(get("hour"));
  const date = new Date(`${get("year")}-${get("month")}-${get("day")}T12:00:00Z`);
  if (p.startHour > p.endHour && hour < p.endHour) date.setUTCDate(date.getUTCDate() - 1);
  return { night: date.toISOString().slice(0, 10), active: p.startHour < p.endHour ? hour >= p.startHour && hour < p.endHour : hour >= p.startHour || hour < p.endHour };
}
export function improvementDeadline(now: number, policy: ImprovementPolicy): number {
  if (!improvementWindow(now, policy).active) return now;
  const end = new Cron(`0 ${policy.endHour} * * *`, { timezone: policy.timezone, paused: true });
  try {
    const next = end.nextRun(new Date(now));
    if (!next) throw Error("No nightly window deadline");
    return next.getTime();
  } finally { end.stop(); }
}

export interface NightState {
  /** Absent on legacy/baseline nights; path identity, not an immutable code digest. */
  strategySelection?: string;
  version: 1;
  night: string;
  turns: number;
  pending?: string;
  done?: boolean;
  closureFeedback?: string;
  closureFailures?: number;
  closureAssessment?: { night: string; inputId: string; turn: number; phase: "claimed" | "decided";
    cancelled?: boolean;
    verdict?: { state: "completed" } | { state: "continue"; next: string } }; 
  results: string[];
  reportQueued?: boolean;
  nextNightRequested?: string;
  experiments?: ExperimentReceipt[];
  recentHypotheses?: string[];
  noExperimentTurns?: number;
}
const KEY = "improvement:nightly";
/** Controller owns time/budget, while Harness owns execution, review, inbox and delivery. */
export class ImprovementController {
  private state?: NightState;
  private checking = false;
  private strategyChanging = false;
  private strategyHolder?: PureStrategy<NightlyStrategy>;

  /** Startup only, before owner input/ticks. Reconcile retained work before loading
   * a local override; mismatch is an explicit startup error, never parser fallback.
   */
  async initializeStrategy(holder: PureStrategy<NightlyStrategy>, selection: StrategySelection): Promise<void> {
    if (this.strategyHolder || this.checking || this.strategyChanging) throw Error("Nightly strategy already initialized or busy");
    this.strategyChanging = true;
    try {
      await this.load();
      if (this.state && (this.state.pending || !this.state.reportQueued) &&
          (selection === null || this.state.strategySelection !== selection)) {
        throw Error("Nightly strategy does not match retained work; restore its original selection");
      }
      if (selection !== undefined) await holder.change(selection, async () => {});
      this.strategyHolder = holder;
    } finally { this.strategyChanging = false; }
  }

  private get currentStrategy(): NightlyStrategy | undefined {
    return this.strategyHolder ? this.strategyHolder.current : this.strategy;
  }

  /** Reserve controller ticks as well as the owner boundary. Strategy changes are
   * deliberately between nights: no migration of pending work or old receipts.
   * The callback validates and persists before publishing its new generation.
   */
  async atStrategyBoundary(change: () => Promise<void>): Promise<void> {
    if (this.checking || this.strategyChanging) throw Error("Nightly strategy busy");
    this.strategyChanging = true;
    try {
      await this.harness.atIdleBoundary(async () => {
        await this.load();
        const session = this.harness.sessions.get(KEY);
        if (session?.running || session?.queue.length || session?.outbox.length) throw Error("Nightly strategy busy");
        if (this.state && (this.state.pending || !this.state.reportQueued)) throw Error("Unreported or pending nightly work; retain current strategy");
        await change();
      });
    } finally { this.strategyChanging = false; }
  }
  private evaluator?: ExperimentEvaluator;
  private evaluatorKey?: string;
  private cronJobs: Cron[] = [];
  private lastSchedulerError = -Infinity;
  private scheduledTick(start: boolean): Promise<void> {
    return this.tick(start).catch((error: unknown) => {
      const now = this.now();
      if (now - this.lastSchedulerError < 300_000) return;
      this.lastSchedulerError = now;
      // Never log exception messages/stacks: policy/parser errors may contain secrets.
      const kind = error instanceof SyntaxError ? "syntax" : error instanceof TypeError ? "type" : "failure";
      console.error(`[improvement] scheduled tick failed (${kind}); retry on next scheduled tick`);
    });
  }
  async start(): Promise<void> {
    const p = await this.policy();
    const run = () => this.scheduledTick(true);
    this.cronJobs = [
      new Cron(`0 ${p.startHour} * * *`, { timezone: p.timezone }, run),
      new Cron(`0 ${p.endHour} * * *`, { timezone: p.timezone }, run),
      // Retry a missed start only inside the authorized window; retained night/budget
      // and foreground/strategy guards still apply when start callbacks overlap.
      new Cron("*/5 * * * *", { timezone: p.timezone }, run),
    ];
    // Catch up a missed start Cron after deployment/restart inside the window.
    // Persisted night identity and budget prevent resetting an existing run.
    await this.tick(true);
  }
  stop(): void { for (const job of this.cronJobs) job.stop(); this.cronJobs = []; }
  async committed(input: Inbound): Promise<void> {
    if (input.sessionKey === KEY) setImmediate(() => { this.scheduledTick(false); });
  }
  constructor(private home: string, private harness: Harness, private timezone: string, private now: () => number, private readonly strategy: NightlyStrategy, private readonly validateClosure?: NightlyCompletionValidator) {}
  private get file(): string { return path.join(this.home, "improvement", "state.json"); }
  async policy(): Promise<ImprovementPolicy> {
    try { return improvementPolicy({ timezone: this.timezone, ...parse(await readFile(path.join(this.home, "improvement.yaml"), "utf8")) }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return improvementPolicy({ timezone: this.timezone }); throw err; }
  }
  private async load(): Promise<void> {
    if (this.state) return;
    try {
      const s = JSON.parse(await readFile(this.file, "utf8")) as NightState;
      if (s.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(s.night) || !Number.isInteger(s.turns) || s.turns < 0 || !Array.isArray(s.results) || s.results.some((r) => typeof r !== "string")) throw Error("Invalid improvement state");
      if (s.closureFailures !== undefined && (!Number.isSafeInteger(s.closureFailures) ||
          s.closureFailures < 0 || s.closureFailures > 3)) throw Error("Invalid nightly closure failure counter");
      const c = s.closureAssessment;
      if (c && (c.night !== s.night || typeof c.inputId !== "string" || !c.inputId || c.inputId !== s.pending ||
          c.turn !== s.turns || !["claimed", "decided"].includes(c.phase) ||
          (c.phase === "claimed" && c.verdict !== undefined) ||
          (c.cancelled !== undefined && typeof c.cancelled !== "boolean") ||
          (c.cancelled === true && c.verdict !== undefined) ||
          (c.verdict !== undefined && c.verdict.state !== "completed" &&
            !(c.verdict.state === "continue" && typeof c.verdict.next === "string" && c.verdict.next.trim() && c.verdict.next.length <= 4000))))
        throw Error("Invalid nightly closure assessment");
      this.state = s;
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  private async save(beforeCommit?: () => void): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileDurable(this.file, JSON.stringify(this.state), 0o600, beforeCommit);
  }
  async evaluate(sessionKey: string, cwd: string, input: ExperimentSpec): Promise<string> {
    const p = await this.policy();
    if (sessionKey !== KEY || !p.enabled || !improvementWindow(this.now(), p).active || !p.evaluator) throw Error("Nightly evaluator unavailable outside configured improvement session/window");
    const key = JSON.stringify(p.evaluator);
    if (key !== this.evaluatorKey) {
      if (this.evaluator) throw Error("Evaluator configuration changed; restart required");
      this.evaluator = new ExperimentEvaluator(cwd, path.join(this.home, "improvement", "experiments"), p.evaluator.runner, p.evaluator.sha256);
      this.evaluatorKey = key;
    }
    return JSON.stringify(await this.evaluator!.evaluate(input));
  }

  async before(input: Inbound): Promise<void> {
    if (input.sessionKey !== KEY) return;
    await this.load();
    const p = await this.policy();
    const w = improvementWindow(this.now(), p);
    if (!p.enabled || !w.active || this.state?.night !== w.night || this.state.pending !== input.id || this.state.turns >= p.maxTurns || this.state.done) throw Error("Improvement work outside authorized window/budget");
    this.state.turns++; // durable reservation before working-model execution, crashes count
    await this.save();
  }
  async completed(input: Inbound, reply: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (input.sessionKey !== KEY || !this.state || this.state.pending !== input.id) return;
    this.state.results.push(reply.slice(0, 4000));
    if (this.state.results.length > 200) this.state.results.shift();
    const strategy = this.currentStrategy;
    if (!strategy) throw Error("Nightly strategy disabled with retained work");
    const progress = structuredClone({ experiments: this.state.experiments, recentHypotheses: this.state.recentHypotheses,
      noExperimentTurns: this.state.noExperimentTurns, done: this.state.done, results: this.state.results });
    strategy.completed(progress, reply);
    this.state.experiments = progress.experiments;
    this.state.recentHypotheses = progress.recentHypotheses;
    this.state.noExperimentTurns = progress.noExperimentTurns;
    // The strategy may end an unproductive loop, but a model marker alone is
    // never authority to finish the entire nightly mandate.
    this.state.done = (progress.noExperimentTurns ?? 0) >= 3;
    this.state.results = progress.results;
    if ((progress.done === true || reply.includes("[IMPROVEMENT_DONE]")) && !this.state.done &&
        (this.state.experiments?.length ?? 0) > 0) {
      const p = await this.policy();
      const w = improvementWindow(this.now(), p);
      let verdict: Inbound["continuation"];
      if (p.enabled && w.active && w.night === this.state.night && !this.harness.stopping &&
          !this.harness.paused && !signal.aborted && (this.state.closureFailures ?? 0) < 3) {
        this.state.closureAssessment = { night: this.state.night, inputId: input.id!, turn: this.state.turns, phase: "claimed" };
        // Reserve before inference, including receipts and the consumed attempt.
        this.state.closureFailures = (this.state.closureFailures ?? 0) + 1;
        await this.save();
        try {
          verdict = await this.validateClosure?.({ signal, expiresAt: improvementDeadline(this.now(), p), input, reply, night: this.state.night,
            turn: this.state.turns, maxTurns: p.maxTurns, experiments: structuredClone(this.state.experiments ?? []) });
        } catch { /* Persist a bounded technical non-decision, never a success. */ }
        const cancelled = signal.aborted;
        const normalized = cancelled ? undefined : verdict?.state === "completed" ? { state: "completed" as const } :
          verdict?.state === "continue" && verdict.next?.trim() ? { state: "continue" as const, next: verdict.next.trim().slice(0, 4000) } : undefined;
        this.state.closureAssessment = { ...this.state.closureAssessment!, phase: "decided", verdict: normalized,
          ...(cancelled ? { cancelled: true } : {}) };
        await this.save(); // Decision is durable before admission; recovery never calls the reviewer again.
      }
      const current = await this.policy();
      const window = improvementWindow(this.now(), current);
      if (current.enabled && window.active && window.night === this.state.night &&
          this.state.turns <= current.maxTurns &&
          !this.harness.stopping && !this.harness.paused && !signal.aborted && this.state.pending === input.id) {
        if (verdict?.state === "completed") {
          this.state.done = true;
          this.state.closureFeedback = undefined;
          this.state.closureFailures = 0;
        } else if (verdict?.state === "continue" && verdict.next?.trim()) {
          this.state.closureFeedback = verdict.next.trim().slice(0, 4000);
          this.state.closureFailures = 0;
        } else {
          this.state.results.push("Nachtabschluss-Validierung ohne gültige Entscheidung; kein bestätigter Abschluss.");
          this.state.closureFeedback = "Nachtabschluss nicht bestätigt. Prüfe die offenen sicheren Kandidaten des gesamten Agenten; wiederhole keine abgeschlossenen Effekte.";
        }
      } else if (this.state.closureAssessment) {
        // Revocation is not a technical failure, but retains the consumed work turn.
        this.state.closureFailures = Math.max(0, (this.state.closureFailures ?? 0) - 1);
      }
    }
    const admitsVerdict = this.state.done === true || this.state.closureFeedback !== undefined;
    this.state.closureAssessment = undefined;
    this.state.pending = undefined;
    try {
      await this.save(() => {
        if (admitsVerdict && signal.aborted) throw Error("Nightly completion commit cancelled");
      });
    } catch (error) {
      // A rename may already have succeeded even when directory sync fails.
      // Discard speculative memory and load the validated published snapshot;
      // never roll back blindly or repeat the reviewer to reconstruct it.
      this.state = undefined;
      try { await this.load(); }
      catch { /* Keep memory unloaded and preserve the original write error. */ }
      throw error;
    }
  }
  async tick(cronStart = true): Promise<void> {
    if (this.harness.stopping || this.harness.updateFenced) return;
    return this.harness.withForegroundWork(() => this.tickForeground(cronStart));
  }

  private async tickForeground(cronStart: boolean): Promise<void> {
    if (this.checking || this.strategyChanging) return;
    this.checking = true;
    try {
      await this.load();
      const strategy = this.currentStrategy;
      // Disabled selection never creates a new reservation or empty night state.
      if (!strategy) return;
      const p = await this.policy();
      const w = improvementWindow(this.now(), p);
      if (cronStart && p.enabled && w.active && this.state && this.state.night !== w.night) {
        this.state.nextNightRequested = w.night;
        await this.save();
      }
      const session = this.harness.sessions.get(KEY);
      const busy = session?.running || session?.queue.length || session?.outbox.length;
      // Report previous window even when disabled meanwhile. Outbox owns retry.
      if (this.state && !busy && (!w.active || this.state.night !== w.night) && !this.state.reportQueued) {
        const to = p.reportTo ?? this.harness.home;
        // Prefer receipts parsed from the full response, before the legacy 4000-character
        // diagnostic truncation. Old states without receipts recover complete blocks only.
        const experiments = strategy.unique(this.state.experiments ?? this.state.results.flatMap(reply => strategy.receipts(reply)));
        const directory = path.join(this.home, "improvement", "reports");
        const artifact = path.join(directory, `${this.state.night}.json`);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFileDurable(artifact, JSON.stringify({
          version: 1, night: this.state.night, timezone: p.timezone,
          turns: this.state.turns, experiments, results: this.state.results,
          delivery: to ? "outbox-pending" : "local-only",
        }));
        if (!to) {
          this.state.reportQueued = true; // handled locally, not remotely delivered
          await this.save();
          return;
        }
        this.harness.post({ id: `improvement-report:${this.state.night}`, sessionKey: KEY, source: "cron", text: "", replyTo: to }, strategy.report(this.state, p.timezone, experiments, artifact));
        await this.harness.onStateChange?.(); // ensure report is durable before marking adopted
        this.state.reportQueued = true;
        await this.save();
        return;
      }
      if (!p.enabled || !w.active) return;
      if (!this.state || this.state.night !== w.night) {
        if (!cronStart && this.state?.nextNightRequested !== w.night) return;
        if (this.state && !this.state.reportQueued) return;
        this.state = { version: 1, strategySelection: this.strategyHolder?.selection ?? undefined, night: w.night, turns: 0, results: [], experiments: [], recentHypotheses: this.state?.recentHypotheses ?? [] };
        await this.save(); // persist Cron intent even if interactive work delays execution
      }
      if (this.harness.paused || busy || [...this.harness.sessions.values()].some((s) => s.running || s.queue.length)) return;
      // An adopted night is closed even if wall time re-enters its old window.
      // Never resume it under a newly selected strategy generation.
      const assessment = this.state.closureAssessment;
      if (assessment) {
        // A saved decision is evidence, not a committed admission. Its write may
        // have raced with cancellation of the originating turn, whose AbortSignal
        // cannot be reconstructed here. Only the final completed() snapshot commits
        // done/feedback after the authority recheck. Never adopt an orphan verdict.
        // Retain its consumed attempt and receipts; do not replay reviewer/worker.
        this.state.results.push("Unterbrochene Nachtabschluss-Prüfung ohne bestätigte Übernahme; gespeichertes Urteil nicht angewendet. Keine abgeschlossenen Effekte wiederholen.");
        this.state.closureAssessment = undefined;
        this.state.pending = undefined;
        await this.save();
      }
      if (this.state.reportQueued || this.state.done || this.state.turns >= p.maxTurns ||
          (this.state.closureFailures ?? 0) >= 3) return;
      if (this.state.pending) {
        this.state.results.push("Vorheriger Versuch unterbrochen oder fehlgeschlagen; vor Fortsetzung tatsächlichen Zustand prüfen.");
        this.state.pending = undefined;
      }
      const id = `improvement:${w.night}:${this.state.turns + 1}`;
      this.state.pending = id;
      await this.save();
      this.harness.enqueue({ id, sessionKey: KEY, source: "cron", text: strategy.prompt(p, this.state.turns + 1) + (this.state.closureFeedback ? `\nVALIDATOR CORRECTION (keine neue Berechtigung): ${this.state.closureFeedback}\n` : "") + `\nBereits untersuchte Hypothesen (nicht wiederholen): ${JSON.stringify(this.state.recentHypotheses ?? [])}\nBisher neue protokollierte Experimente dieser Nacht: ${this.state.experiments?.length ?? 0}. Turns ohne neues Experiment: ${this.state.noExperimentTurns ?? 0}.` });
    } finally { this.checking = false; }
  }
}
