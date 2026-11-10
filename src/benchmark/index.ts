import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { BenchmarkConfig } from "./config.js";
import { benchmarkConfig } from "./config.js";
import { benchmarkEpoch } from "./epoch.js";
import { renderBenchmarkReport } from "./report.js";
import { BenchmarkRunner, type BenchmarkRunOutcome, type BenchmarkRunRecord, type BenchmarkSubmitter } from "./runner.js";
import { assertTaskIsolation, parseBenchmarkSuite, suiteFingerprint, type BenchmarkSuite } from "./suite.js";

export interface BenchmarkServiceOptions {
  /** Harness home: suites in <home>/benchmark/suites, records in <home>/benchmark/runs. */
  home: string;
  /** Live settings read, so an operator can enable the subsystem without a rebuild. */
  config: () => Partial<BenchmarkConfig> | undefined;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable acceptance runner; the default shells out with sh. */
  execute?: (command: string, cwd: string, timeoutMs: number) => Promise<{ exitCode: number | null; output: string }>;
}

function isRecord(value: unknown): value is BenchmarkRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.suite === "string" && Array.isArray(record.outcomes)
    && !!record.epoch && typeof record.epoch === "object";
}

/**
 * Owns suite discovery, run orchestration and stored results. Deliberately
 * inert unless the operator enables it: a benchmark that submits real worker
 * tasks is not something to trigger by accident.
 */
export class BenchmarkService {
  private running?: { suite: string; startedAt: number };
  constructor(private readonly dispatcher: BenchmarkSubmitter, private readonly options: BenchmarkServiceOptions) {}

  private get settings(): BenchmarkConfig { return benchmarkConfig(this.options.config()); }
  private get suitesDir(): string { return path.join(this.options.home, "benchmark", "suites"); }
  private get runsDir(): string { return this.settings.runsDir ?? path.join(this.options.home, "benchmark", "runs"); }

  async suites(): Promise<string[]> {
    try {
      return (await readdir(this.suitesDir)).filter(name => /\.ya?ml$/.test(name)).map(name => name.replace(/\.ya?ml$/, "")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async load(name: string): Promise<{ suite: BenchmarkSuite; source: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw Error(`Invalid benchmark suite name: ${name}`);
    const source = path.join(this.suitesDir, `${name}.yaml`);
    let raw: string;
    try {
      raw = await readFile(source, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Error(`Unknown benchmark suite "${name}". Known: ${(await this.suites()).join(", ") || "none"}`);
      throw error;
    }
    const suite = parseBenchmarkSuite(parse(raw));
    for (const item of suite.cases) assertTaskIsolation(item);
    return { suite, source };
  }

  /** Writes a suite file atomically so an interrupted edit cannot leave a half suite behind. */
  async save(name: string, contents: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw Error(`Invalid benchmark suite name: ${name}`);
    parseBenchmarkSuite(parse(contents)).cases.forEach(assertTaskIsolation);
    await mkdir(this.suitesDir, { recursive: true });
    const target = path.join(this.suitesDir, `${name}.yaml`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, target);
    return target;
  }

  async run(name: string, parent: string, onProgress?: (outcome: BenchmarkRunOutcome) => void): Promise<BenchmarkRunRecord> {
    const settings = this.settings;
    if (!settings.enabled) throw Error("Benchmarking is disabled. Set benchmark.enabled to run a suite.");
    if (this.running) throw Error(`Benchmark "${this.running.suite}" is already running since ${new Date(this.running.startedAt).toISOString()}.`);
    const { suite } = await this.load(name);
    const epoch = await benchmarkEpoch(this.options.home);
    this.running = { suite: suite.name, startedAt: Date.now() };
    try {
      const runner = new BenchmarkRunner(this.dispatcher, {
        home: this.options.home, parent, dir: this.runsDir, caseTimeoutMs: settings.caseTimeoutMs,
        now: this.options.now, ...(this.options.execute ? { execute: this.options.execute } : {}),
      });
      return await runner.run(suite, suiteFingerprint(suite, { revision: epoch.revision, models: epoch.modelsFingerprint, settings: epoch.settingsFingerprint }), epoch, onProgress);
    } finally {
      this.running = undefined;
    }
  }

  async latest(limit = 5, suite?: string): Promise<BenchmarkRunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.runsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: BenchmarkRunRecord[] = [];
    for (const name of names.sort().reverse()) {
      if (suite && !name.startsWith(`${suite}-`)) continue;
      try {
        const parsed = JSON.parse(await readFile(path.join(this.runsDir, name, "record.json"), "utf8")) as unknown;
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        continue; // a half written record directory is noise, not a reason to fail the whole report
      }
      if (records.length >= limit) break;
    }
    return records;
  }

  async report(suite?: string): Promise<string> {
    const records = await this.latest(suite ? 1 : 3, suite);
    const epoch = await benchmarkEpoch(this.options.home);
    return renderBenchmarkReport(records, epoch);
  }

  status(): { enabled: boolean; config: BenchmarkConfig; running: { suite: string; startedAt: number } | null; suitesDir: string; runsDir: string } {
    return { enabled: this.settings.enabled, config: this.settings, running: this.running ? { ...this.running } : null, suitesDir: this.suitesDir, runsDir: this.runsDir };
  }
}
