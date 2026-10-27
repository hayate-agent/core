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
  const p = { enabled: false, startHour: 23, endHour: 5, maxTurns: 20, timezone: "UTC", pullRequest: false, merge: false, ...input };
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
export interface NightState {
  /** Absent on legacy/baseline nights; path identity, not an immutable code digest. */
  strategySelection?: string;
  version: 1;
  night: string;
  turns: number;
  pending?: string;
  done?: boolean;
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
  async start(): Promise<void> {
    const p = await this.policy();
    const run = () => { void this.tick(true).catch(() => undefined); };
    this.cronJobs = [
      new Cron(`0 ${p.startHour} * * *`, { timezone: p.timezone }, run),
      new Cron(`0 ${p.endHour} * * *`, { timezone: p.timezone }, run),
      // State-only recovery, not a periodic model nudge. Starts no fresh night.
      new Cron("*/5 * * * *", { timezone: p.timezone }, () => { void this.tick(false).catch(() => undefined); }),
    ];
    // Catch up a missed start Cron after deployment/restart inside the window.
    // Persisted night identity and budget prevent resetting an existing run.
    await this.tick(true);
  }
  stop(): void { for (const job of this.cronJobs) job.stop(); this.cronJobs = []; }
  async committed(input: Inbound): Promise<void> {
    if (input.sessionKey === KEY) setImmediate(() => { void this.tick(false).catch(() => undefined); });
  }
  constructor(private home: string, private harness: Harness, private timezone: string, private now: () => number, private readonly strategy: NightlyStrategy) {}
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
      this.state = s;
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileDurable(this.file, JSON.stringify(this.state));
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
  async completed(input: Inbound, reply: string): Promise<void> {
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
    this.state.done = progress.done;
    this.state.results = progress.results;
    this.state.pending = undefined;
    await this.save();
  }
  async tick(cronStart = true): Promise<void> {
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
      if (this.state.reportQueued || this.state.done || this.state.turns >= p.maxTurns) return;
      if (this.state.pending) {
        this.state.results.push("Vorheriger Versuch unterbrochen oder fehlgeschlagen; vor Fortsetzung tatsächlichen Zustand prüfen.");
        this.state.pending = undefined;
      }
      const id = `improvement:${w.night}:${this.state.turns + 1}`;
      this.state.pending = id;
      await this.save();
      this.harness.enqueue({ id, sessionKey: KEY, source: "cron", text: strategy.prompt(p, this.state.turns + 1) + `\nBereits untersuchte Hypothesen (nicht wiederholen): ${JSON.stringify(this.state.recentHypotheses ?? [])}\nBisher neue protokollierte Experimente dieser Nacht: ${this.state.experiments?.length ?? 0}. Turns ohne neues Experiment: ${this.state.noExperimentTurns ?? 0}.` });
    } finally { this.checking = false; }
  }
}
