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
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Cron } from "croner";
import { parse } from "yaml";
import { type Harness, NO_REPLY } from "./harness.js";
import type { Address } from "./types.js";

const run = promisify(execFile);

export interface CronJob {
  name: string;
  schedule: string;
  prompt?: string;
  prompt_file?: string;
  script?: string;
  no_agent?: boolean;
  model?: string | { model: string; provider?: string };
  /** "origin" | "local" | "<channel>:<target>" */
  deliver?: string;
  origin?: { platform: string; chat_id: string; thread_id?: string | null };
  enabled?: boolean;
  absent?: boolean;
}

export function parseJobs(text: string): CronJob[] {
  const doc = (parse(text) ?? {}) as { jobs?: CronJob[] };
  const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
  for (const j of jobs) {
    if (!j || typeof j.name !== "string") throw new Error("cron job without name");
    if (!j.absent && typeof j.schedule !== "string") throw new Error(`cron job "${j.name}" has no schedule`);
  }
  return jobs.filter((j) => !j.absent);
}

/** Resolve the delivery address; undefined = local (log only). */
export function resolveDelivery(job: CronJob, home?: Address): Address | undefined | "home" {
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

  constructor(
    private readonly harness: Harness,
    private readonly opts: SchedulerOptions,
  ) {
    this.log = opts.log ?? ((m) => console.error(`[cron] ${m}`));
  }

  async load(): Promise<void> {
    if (!this.opts.jobsFile) { this.stop(); this.jobs = []; return; }
    let text: string;
    try {
      text = await readFile(this.opts.jobsFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") { this.stop(); this.jobs = []; return; }
      throw err;
    }
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

  async runJob(job: CronJob): Promise<void> {
    if (this.harness.paused) return;
    let scriptOut = "";
    if (job.script) {
      const scriptsDir = this.opts.scriptsDir ?? path.join(this.baseDir(), "scripts");
      const file = path.resolve(scriptsDir, job.script);
      if (!file.startsWith(path.resolve(scriptsDir) + path.sep)) throw new Error(`script outside scripts dir: ${job.script}`);
      // Enforce the deadline even when the direct script ignores SIGTERM. This is
      // not process-tree isolation: independently running descendants may survive.
      const { stdout } = await run(file, [], { timeout: 10 * 60_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
      scriptOut = stdout.trim();
    }
    const delivery = resolveDelivery(job, this.harness.home);
    const to = delivery === "home" ? this.harness.home : delivery;

    if (job.no_agent) {
      if (scriptOut && scriptOut !== NO_REPLY) {
        if (to) await this.harness.deliver(to, scriptOut);
        else this.log(`${job.name}: ${scriptOut.slice(0, 200)}`);
      }
      return;
    }

    let prompt = job.prompt ?? "";
    if (job.prompt_file) prompt = await readFile(path.resolve(this.baseDir(), job.prompt_file), "utf8");
    if (scriptOut) prompt += `\n\n## Script output\n\n${scriptOut}`;
    if (!prompt.trim()) return;
    prompt += `\n\n(Scheduled job "${job.name}". If there is nothing worth reporting, reply exactly ${NO_REPLY}.)`;
    this.harness.enqueue({ sessionKey: `cron:${job.name}`, text: prompt, source: "cron", replyTo: to });
  }
}
