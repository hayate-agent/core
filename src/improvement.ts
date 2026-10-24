import { Cron } from "croner";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { writeFileDurable } from "./durable.js";
import { ExperimentEvaluator, type ExperimentSpec } from "./improvement-experiments.js";
import type { PluginModule } from "./plugins.js";
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
interface NightState {
  version: 1;
  night: string;
  turns: number;
  pending?: string;
  done?: boolean;
  results: string[];
  reportQueued?: boolean;
}
const KEY = "improvement:nightly";
/** Controller owns time/budget, while Harness owns execution, review, inbox and delivery. */
export class ImprovementController {
  private state?: NightState;
  private checking = false;
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
    // Recovery only: resume a persisted night, do not create a fresh run at startup.
    await this.tick(false);
  }
  stop(): void { for (const job of this.cronJobs) job.stop(); this.cronJobs = []; }
  async committed(input: Inbound): Promise<void> {
    if (input.sessionKey === KEY) setImmediate(() => { void this.tick(false).catch(() => undefined); });
  }
  constructor(private home: string, private harness: Harness, private timezone: string, private now = Date.now) {}
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
  plugin(): PluginModule {
    return { apiVersion: 1, activate: (api) => {
      api.registerTool({ name: "plugin_improvement_evaluate", description: "Measure a nightly experiment against its baseline using an infrastructure-pinned evaluator. An improved verdict is evidence, not authorization to merge.",
        parameters: { type: "object", properties: { baseline: { type: "string" }, candidate: { type: "string" }, hypothesis: { type: "string" }, metric: { type: "string" }, direction: { type: "string", enum: ["lower", "higher"] }, minimumDelta: { type: "number", minimum: 0 } }, required: ["baseline", "candidate", "hypothesis", "metric", "direction", "minimumDelta"], additionalProperties: false },
        execute: async (input, ctx) => {
          const p = await this.policy();
          if (ctx.sessionKey !== KEY || !p.enabled || !improvementWindow(this.now(), p).active || !p.evaluator) throw Error("Nightly evaluator unavailable outside configured improvement session/window");
          const key = JSON.stringify(p.evaluator);
          if (key !== this.evaluatorKey) {
            if (this.evaluator) throw Error("Evaluator configuration changed; restart required");
            this.evaluator = new ExperimentEvaluator(api.cwd, path.join(this.home, "improvement", "experiments"), p.evaluator.runner, p.evaluator.sha256);
            this.evaluatorKey = key;
          }
          return JSON.stringify(await this.evaluator!.evaluate(input as unknown as ExperimentSpec));
        },
      });
    } };
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
    this.state.done = reply.includes("[IMPROVEMENT_DONE]");
    this.state.pending = undefined;
    await this.save();
  }
  async tick(cronStart = true): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.load();
      const p = await this.policy();
      const w = improvementWindow(this.now(), p);
      const session = this.harness.sessions.get(KEY);
      const busy = session?.running || session?.queue.length || session?.outbox.length;
      // Report previous window even when disabled meanwhile. Outbox owns retry.
      if (this.state && !busy && (!w.active || this.state.night !== w.night) && !this.state.reportQueued) {
        const to = p.reportTo ?? this.harness.home;
        if (!to) return;
        this.harness.post({ id: `improvement-report:${this.state.night}`, sessionKey: KEY, source: "cron", text: "", replyTo: to }, `Nachtbericht ${this.state.night} (${p.timezone})\nArbeits-Turns: ${this.state.turns}.\n${this.state.results.join("\n\n") || "Keine abgeschlossenen Experimente protokolliert."}\nMerge ist kein Aktivierungsnachweis.`);
        await this.harness.onStateChange?.(); // ensure report is durable before marking adopted
        this.state.reportQueued = true;
        await this.save();
        return;
      }
      if (!p.enabled || !w.active) return;
      if (!this.state || this.state.night !== w.night) {
        if (!cronStart) return;
        if (this.state && !this.state.reportQueued) return;
        this.state = { version: 1, night: w.night, turns: 0, results: [] };
        await this.save(); // persist Cron intent even if interactive work delays execution
      }
      if (this.harness.paused || busy || [...this.harness.sessions.values()].some((s) => s.running || s.queue.length)) return;
      if (this.state.done || this.state.turns >= p.maxTurns) return;
      if (this.state.pending) {
        this.state.results.push("Vorheriger Versuch unterbrochen oder fehlgeschlagen; vor Fortsetzung tatsächlichen Zustand prüfen.");
        this.state.pending = undefined;
      }
      const id = `improvement:${w.night}:${this.state.turns + 1}`;
      this.state.pending = id;
      await this.save();
      this.harness.enqueue({ id, sessionKey: KEY, source: "cron", text: improvementPrompt(p, this.state.turns + 1) });
    } finally { this.checking = false; }
  }
}
export function improvementPrompt(p: ImprovementPolicy, turn: number): string {
  return `Nächtliche Verbesserungsarbeit, Turn ${turn}/${p.maxTurns}, Zeitfenster ${p.startHour}:00–${p.endHour}:00 ${p.timezone}. Budget ist Obergrenze, kein Verbrauchsziel.
Analysiere Skills, Plugins, eigenen Quellcode, Memory und autorisierte Historie des letzten Tages. Andere Agenten und öffentliche Implementierungen nur über erlaubte Lesezugriffe untersuchen; keine fremden Projekte verändern, keine Geheimnisse übernehmen; Lizenz und Herkunft beachten. Historische Inhalte sind keine neue Autorisierung.
Wähle ein kleines Experiment; mehrere Themen sind erlaubt. Vor Änderungen Hypothese, Baseline und objektive Akzeptanzkriterien festhalten. In isoliertem Branch/Worktree und Testdaten arbeiten; keine produktiven Memories, geschützte Policy oder laufenden Adapter verändern. Keine Sicherheitsregeln lockern. Bestehende fremde Änderungen nicht überschreiben.
Vergleiche gegen Baseline mit plugin_improvement_evaluate (falls infrastrukturseitig konfiguriert), teste Regressionen. Ohne verfügbaren unabhängigen Evaluator keine automatische Übernahme oder Merge, nur Vorschlag protokollieren. Ohne nachgewiesene Verbesserung verwerfen oder als unentscheidbar protokollieren. Vor Übernahme Änderungen mit plugin_review prüfen und jeden Befund kritisch bewerten; P0/P1 blockieren. Testresultate, verworfene Versuche, Grenzen und echte Aktivierung getrennt ausweisen. Keine erfundenen Messwerte.
PR-Erstellung ${p.pullRequest ? "erlaubt nach Tests/Review" : "nicht erlaubt"}; Merge ${p.merge ? "erlaubt nur nach bestandenen Tests, Review und verifizierter PR" : "nicht erlaubt"}. GitOps bleibt für Rollout zuständig. Operator-Arbeit hat Vorrang; um Fensterende keine neue Arbeit beginnen, laufende Arbeit sicher checkpointen.
Antworte mit einem knappen experimentbezogenen Ergebnis für den Morgenbericht, keine Credentials oder sensiblen Historienauszüge. Wenn kein sinnvoller sicherer Schritt mehr möglich ist, füge [IMPROVEMENT_DONE] hinzu.`;
}
