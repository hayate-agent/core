/**
 * Cron scheduler, compatible with the Hermes `cron/jobs.yaml` format used by the
 * agent config repos (name, schedule, script, no_agent, prompt_file, model, deliver, origin, enabled).
 *
 * Execution model (as in Hermes):
 * - `script` runs first; its stdout becomes context for the prompt.
 * - `no_agent: true` runs only the script; non-empty stdout is delivered as-is.
 * - Otherwise the prompt (+ script output) runs as an agent turn in session `cron:<name>`.
 * - NO_REPLY output stays silent.
 */
import { languageTag } from "./language.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Cron } from "croner";
import { parse } from "yaml";
import { type Harness, NO_REPLY } from "./harness.js";
import type { Address } from "./types.js";

const run = promisify(execFile);

export interface CronJob {
  /** Optional BCP-47 output language; omission inherits background/system defaults. */
  language?: string;
  name: string;
  schedule: string;
  prompt?: string;
  prompt_file?: string;
  script?: string;
  no_agent?: boolean;
  /** Explicit audience; omitted preserves legacy delivery behavior. */
  audience?: "agent" | "user";
  /** Execution scope for post-report follow-up; absent means analysis only. */
  follow_up?: { authorization: string; max_tasks: number };
  model?: string | { model: string; provider?: string };
  /** "origin" | "local" | "<channel>:<target>" */
  deliver?: string;
  /** Captured creator context; user_id distinguishes provenance from delivery-only config. */
  origin?: { platform: string; chat_id: string; thread_id?: string | null; user_id?: string };
  enabled?: boolean;
  absent?: boolean;
}

export function parseJobs(text: string): CronJob[] {
  const doc = (parse(text) ?? {}) as { jobs?: CronJob[] };
  const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
  for (const j of jobs) {
    if (!j || typeof j.name !== "string") throw new Error("cron job without name");
    if (!j.absent && typeof j.schedule !== "string") throw new Error(`cron job "${j.name}" has no schedule`);
    if (j.language !== undefined) languageTag(j.language);
    if (j.audience !== undefined && !["agent", "user"].includes(j.audience)) throw Error("Invalid cron audience");
    if (j.audience === "agent" && j.no_agent) throw Error("Agent-only cron requires agent processing");
    if (j.follow_up && (!j.audience || typeof j.follow_up.authorization !== "string" ||
        !j.follow_up.authorization.trim() || j.follow_up.authorization.length > 4000 ||
        !Number.isInteger(j.follow_up.max_tasks) || j.follow_up.max_tasks < 1 || j.follow_up.max_tasks > 3)) throw Error("Invalid cron follow_up");
  }
  return jobs.filter((j) => !j.absent);
}

/** Resolve the delivery address; undefined = local (log only). */
export function resolveDelivery(job: CronJob, home?: Address): Address | undefined | "home" {
  if (job.audience === "agent") return undefined;
  const d = job.deliver ?? "origin";
  if (d === "local") return undefined;
  if (d === "origin") {
    if (job.origin?.platform && job.origin.chat_id) {
      return { channel: job.origin.platform, target: job.origin.chat_id, thread: job.origin.thread_id ?? undefined };
    }
    return home ? "home" : undefined;
  }
  const i = d.indexOf(":");
  if (i > 0) return { channel: d.slice(0, i), target: d.slice(i + 1) };
  return undefined;
}

export interface SchedulerOptions {
  /** Resolve once when admitting each occurrence, not when delivering its report. */
  language?: (job: CronJob) => string;
  jobsFile?: string;
  /** Directory scripts are resolved against (default: <jobs dir>/scripts). */
  scriptsDir?: string;
  timezone: string;
  log?: (msg: string) => void;
}

export class Scheduler {
  private crons: Cron[] = [];
  jobs: CronJob[] = [];
  /** Runtime overrides from /cron pause|resume (persisted by the caller). */
  readonly overrides = new Map<string, boolean>();
  private readonly log: (m: string) => void;
  private readonly active = new Map<string, Set<{ creator?: string; abort: AbortController; done: Promise<void> }>>();
  private readonly resettingNames = new Set<string>();
  private readonly resettingParents = new Set<string>();
  private resetGeneration = 0;

  private creator(job: CronJob): string | undefined {
    const origin = job.origin;
    if (!origin?.user_id?.trim() || !origin.platform || !origin.chat_id ||
        ["cron", "dispatch", "subagent", "loop", "heartbeat", "goal"].includes(origin.platform)) return undefined;
    return `${origin.platform}:${origin.chat_id}${origin.thread_id ? `:${origin.thread_id}` : ""}`;
  }

  private originResetPending(job: CronJob): boolean {
    const key = this.creator(job);
    return !!this.harness.sessions?.get(`cron:${job.name}`)?.resetPending ||
      !!this.harness.sessions && [...this.harness.sessions.values()].some(s => s.resetPending && s.resetSources?.includes(`cron:${job.name}`)) ||
      !!key && !!this.harness.sessions.get(key)?.resetPending;
  }

  /** Only creator provenance, never a matching delivery address, binds a job. */
  async resetConversation(parent: string,
    reset?: (sources: () => Promise<readonly string[]>, planned: readonly string[]) => Promise<void>): Promise<string[]> {
    const owned = this.jobs.filter(job => this.creator(job) === parent);
    const persisted = this.harness.sessions?.get(parent)?.resetSources ?? [];
    if (!Array.isArray(persisted) || persisted.some(source => typeof source !== "string" || !source.startsWith("cron:")))
      throw Error("Invalid reset source provenance");
    const activeNames = [...this.active].filter(([, tasks]) => [...tasks].some(task => task.creator === parent)).map(([name]) => name);
    const retained = [...this.harness.sessions?.values() ?? []]
      .filter(s => s.key.startsWith("cron:") && s.sourceOwner === parent).map(s => s.key.slice(5));
    const names = new Set([...owned.map(job => job.name), ...activeNames, ...retained, ...persisted.map(source => source.slice(5))]);
    if (this.jobs.some(job => names.has(job.name) && this.creator(job) !== parent) ||
        [...names].some(name => [...this.active.get(name) ?? []].some(task => task.creator !== parent) ||
          !!this.harness.sessions?.get(`cron:${name}`)?.sourceOwner && this.harness.sessions.get(`cron:${name}`)!.sourceOwner !== parent))
      throw Error("Ambiguous cron name ownership; reset not completed");
    if (this.resettingParents.has(parent) || [...names].some(name => this.resettingNames.has(name))) throw Error("Cron reset in progress");
    // Reserve the exact preflight set synchronously, before parent stop or any
    // async persistence. Hold it through all recursive resets and fresh opening.
    for (const name of names) this.resettingNames.add(name);
    this.resettingParents.add(parent); this.resetGeneration++;
    const parents = [...names].map(name => `cron:${name}`);
    const sources = async () => {
      for (const name of names) this.overrides.set(name, false);
      this.jobs.forEach((job, i) => { if (names.has(job.name)) this.crons[i]?.pause(); });
      if (names.size) await this.harness.onStateChange?.();
      const active = [...names].flatMap(name => [...this.active.get(name) ?? []]).filter(task => task.creator === parent);
      for (const task of active) task.abort.abort();
      await Promise.allSettled(active.map(task => task.done));
      return parents;
    };
    try {
      if (reset) await reset(sources, parents); else await sources();
      return parents;
    } finally {
      for (const name of names) this.resettingNames.delete(name);
      this.resettingParents.delete(parent);
    }
  }

  constructor(
    private readonly harness: Harness,
    private readonly opts: SchedulerOptions,
  ) {
    this.log = opts.log ?? ((m) => console.error(`[cron] ${m}`));
  }

  async load(): Promise<void> {
    if (this.resettingParents.size) throw Error("Cron reset in progress; retry reload");
    const generation = this.resetGeneration;
    if (!this.opts.jobsFile) { this.stop(); this.jobs = []; return; }
    let text: string;
    try {
      text = await readFile(this.opts.jobsFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.resettingParents.size || generation !== this.resetGeneration) throw Error("Cron reset in progress or changed; retry reload");
        this.stop(); this.jobs = []; return;
      }
      throw err;
    }
    if (this.resettingParents.size || generation !== this.resetGeneration) throw Error("Cron reset in progress or changed; retry reload");
    const jobs = parseJobs(text);
    const crons: Cron[] = [];
    try {
      // Prepare paused: invalid later definitions must not replace or partially start the schedule.
      for (const job of jobs) {
        crons.push(new Cron(job.schedule, { timezone: this.opts.timezone, paused: true, protect: true }, () =>
          this.runJob(job).catch((err) => this.log(`${job.name}: ${err instanceof Error ? err.message : err}`)),
        ));
      }
    } catch (err) {
      for (const cron of crons) cron.stop();
      throw err;
    }
    this.stop();
    this.jobs = jobs;
    this.crons = crons;
    for (let i = 0; i < jobs.length; i++) {
      if (this.overrides.get(jobs[i].name) ?? jobs[i].enabled !== false) crons[i].resume();
    }
    this.log(`loaded ${this.jobs.length} job(s) from ${this.opts.jobsFile}`);
  }

  stop(): void {
    for (const c of this.crons) c.stop();
    this.crons = [];
  }

  list(): Array<{ name: string; schedule: string; next?: string; enabled: boolean }> {
    return this.jobs.map((job, i) => ({
      name: job.name,
      schedule: job.schedule,
      next: this.crons[i]?.nextRun()?.toISOString(),
      enabled: !!this.crons[i]?.isRunning(),
    }));
  }

  find(name: string): CronJob | undefined {
    return this.jobs.find((j) => j.name === name);
  }

  setEnabled(name: string, enabled: boolean): boolean {
    if (enabled && this.resettingNames.has(name)) throw Error("Cron reset in progress; retry enable");
    const i = this.jobs.findIndex((j) => j.name === name);
    if (i < 0) return false;
    this.overrides.set(name, enabled);
    if (enabled) this.crons[i]?.resume();
    else this.crons[i]?.pause();
    return true;
  }

  private baseDir(): string {
    return this.opts.jobsFile ? path.dirname(this.opts.jobsFile) : process.cwd();
  }

  async runJob(job: CronJob, explicit = false): Promise<void> {
    if (this.resettingNames.has(job.name) || this.resettingParents.has(this.creator(job) ?? "") || this.harness.paused || this.harness.stopping || this.harness.updateFenced || !explicit && this.overrides.get(job.name) === false ||
        this.originResetPending(job)) return;
    const abort = new AbortController();
    const done = this.harness.withForegroundWork(async () => {
      const owner = this.creator(job);
      const previousOwner = this.harness.sessions?.get(`cron:${job.name}`)?.sourceOwner;
      if (previousOwner && previousOwner !== owner) throw Error("Cron creator ownership changed; reconcile source first");
      if (owner) {
        const source = this.harness.state(`cron:${job.name}`);
        source.sourceOwner = owner;
        await this.harness.onStateChange?.();
      }
      this.assertOccurrence(job, abort.signal);
      await this.runJobForeground(job, abort.signal);
    });
    const active = this.active.get(job.name) ?? new Set(); this.active.set(job.name, active);
    const task = { creator: this.creator(job), abort, done }; active.add(task);
    try { await done; }
    finally { active.delete(task); if (!active.size) this.active.delete(job.name); }
  }

  private assertOccurrence(job: CronJob, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.originResetPending(job))
      throw Error("Origin conversation reset; old occurrence revoked");
  }

  private async runJobForeground(job: CronJob, signal: AbortSignal): Promise<void> {
    this.assertOccurrence(job, signal);
    const language = languageTag(this.opts.language?.(job) ?? job.language ?? "en");
    let scriptOut = "";
    if (job.script) {
      const scriptsDir = this.opts.scriptsDir ?? path.join(this.baseDir(), "scripts");
      const file = path.resolve(scriptsDir, job.script);
      if (!file.startsWith(path.resolve(scriptsDir) + path.sep)) throw new Error(`script outside scripts dir: ${job.script}`);
      // Enforce the deadline even when the direct script ignores SIGTERM. This is
      // not process-tree isolation: independently running descendants may survive.
      const running = run(file, [], { timeout: 10 * 60_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
      const stop = () => { running.child.kill("SIGTERM"); };
      signal.addEventListener("abort", stop, { once: true });
      try { const { stdout } = await running; scriptOut = stdout.trim(); }
      finally { signal.removeEventListener("abort", stop); }
    }
    this.assertOccurrence(job, signal);
    const delivery = resolveDelivery(job, this.harness.home);
    const to = delivery === "home" ? this.harness.home : delivery;

    if (job.audience === "user" && !to) throw Error("User cron requires a delivery destination");
    const metadata = job.audience ? { job: job.name, runId: randomUUID(), createdAt: Date.now(), audience: job.audience,
      original: job.prompt ?? job.prompt_file ?? `Run configured script for ${job.name}`,
      authorization: job.follow_up?.authorization, maxTasks: job.follow_up?.max_tasks ?? 0 } : undefined;
    if (job.no_agent && metadata) {
      if (scriptOut && scriptOut !== NO_REPLY) await this.harness.accept({ id: metadata.runId, sessionKey: `cron:${job.name}`,
        text: metadata.original, source: "cron", language, replyTo: to, cronReport: { ...metadata, output: scriptOut } });
      return;
    }
    if (job.no_agent) {
      if (scriptOut && scriptOut !== NO_REPLY) {
        if (to) await this.harness.deliver(to, scriptOut);
        else this.log(`${job.name}: ${scriptOut.slice(0, 200)}`);
      }
      return;
    }

    let prompt = job.prompt ?? "";
    if (job.prompt_file) prompt = await readFile(path.resolve(this.baseDir(), job.prompt_file), "utf8");
    this.assertOccurrence(job, signal);
    if (scriptOut) prompt += `\n\n## Script output\n\n${scriptOut}`;
    if (!prompt.trim()) return;
    prompt += `\n\n(Scheduled job "${job.name}". If there is nothing worth reporting, reply exactly ${NO_REPLY}.)`;
    if (metadata) {
      metadata.original = prompt;
      await this.harness.accept({ id: metadata.runId, sessionKey: `cron:${job.name}`, text: prompt, source: "cron", language, replyTo: to, cronReport: metadata });
    } else this.harness.enqueue({ sessionKey: `cron:${job.name}`, text: prompt, source: "cron", language, replyTo: to });
  }
}
