import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Execution, ExecutionStatus } from "../execution.js";
import type { BenchmarkEpoch } from "./epoch.js";
import { locateWorkerSessionDirs, readWorkerMetrics, type WorkerMetrics } from "./metrics.js";
import { assertTaskIsolation, benchmarkRuns, type BenchmarkCase, type BenchmarkFixtureFile, type BenchmarkSuite } from "./suite.js";

/** Structurally satisfied by Dispatcher plus ExecutionStore; narrow so a run is testable without a GPU. */
export interface BenchmarkSubmitter {
  submitScheduled(parent: string, requestId: string, input: string, mandate: NonNullable<Execution["dependency"]>, pinned?: Execution["pinned"]): Promise<{ id: string }>;
  waitForExecution(id: string): Promise<void>;
  control(parent: string, id: string, action: "pause" | "resume" | "cancel"): Promise<void>;
  list(parent?: string): Execution[];
}

export interface BenchmarkAcceptance { command: string; exitCode: number | null; outputTail: string }

export interface BenchmarkRunOutcome {
  caseId: string;
  repeat: number;
  taskId: string;
  requestId: string;
  pin: { model: string; thinking: string };
  status: ExecutionStatus | "timeout" | "preflight-failed";
  /** Wall clock including queueing; metrics durationMs is model time only. */
  wallMs: number;
  workspace: string;
  attempts: WorkerMetrics[];
  acceptance?: BenchmarkAcceptance;
  verifier?: BenchmarkAcceptance;
  /** Fixture the worker changed as intended, i.e. the declared deliverable. */
  fixed: string[];
  /** Frozen fixture the worker changed. Disqualifies the run on its own. */
  tampered: string[];
  /** Files the worker added. Reported, not disqualifying: acceptance and verifier decide. */
  extra: string[];
  /** Observed in the worker session log; has to match the pin or the run proves nothing. */
  model?: string;
  thinkingLevel?: string;
  pinMatches: boolean;
  preflight?: { status: "ok" | "skipped" | "failed"; reason?: string };
  verified: boolean;
  diagnostic?: string;
}

export interface BenchmarkRunRecord {
  id: string;
  suite: string;
  fingerprint: string;
  epoch: BenchmarkEpoch;
  startedAt: number;
  finishedAt?: number;
  outcomes: BenchmarkRunOutcome[];
}

export interface BenchmarkRunnerOptions {
  /** Harness home; worker session logs live in <home>/sessions/dispatch_<taskId>_*. */
  home: string;
  /** Session key the delegated tasks are parented to. */
  parent: string;
  /** Directory that holds run records; each run gets one subdirectory with its fixtures and record.json. */
  dir: string;
  caseTimeoutMs: number;
  now?: () => number;
  /** Injectable so tests do not need a shell; default runs the acceptance command with sh. */
  execute?: (command: string, cwd: string, timeoutMs: number) => Promise<{ exitCode: number | null; output: string }>;
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function defaultExecute(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  return await new Promise(resolve => {
    const child = spawn("sh", ["-c", command], { cwd });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", error => { clearTimeout(timer); resolve({ exitCode: null, output: `${output}\n${error.message}`.slice(-4_000) }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: signal ? null : code, output: signal ? `${output}\nkilled:${signal}` : output });
    });
  });
}

/**
 * Executes a suite one run at a time against the real dispatcher with a pinned
 * worker pair. Everything that decides "did it work" stays on this side: the
 * fixture checksums, the acceptance command and the expectation.
 */
export class BenchmarkRunner {
  constructor(private readonly dispatcher: BenchmarkSubmitter, private readonly options: BenchmarkRunnerOptions) {}

  private stamp(): number { return this.options.now?.() ?? Date.now(); }

  /** Task text deliberately carries the workspace path and nothing that reveals the expected outcome. */
  private taskText(item: BenchmarkCase, workspace: string): string {
    return `${item.task}\n\nArbeitsverzeichnis: ${workspace}\nAlle Dateien dieses Falls liegen dort; arbeite ausschließlich in diesem Verzeichnis.`;
  }

  private async materialize(item: BenchmarkCase, workspace: string, override: readonly BenchmarkFixtureFile[] = []): Promise<Map<string, string>> {
    await mkdir(workspace, { recursive: true });
    const contents = new Map(item.fixtures.map(fixture => [fixture.path, fixture.contents] as const));
    for (const file of override) contents.set(file.path, file.contents);
    const declared = new Map<string, string>();
    for (const fixture of item.fixtures.map(file => ({ path: file.path, contents: contents.get(file.path)! }))) {
      const target = path.join(workspace, fixture.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, fixture.contents);
      declared.set(fixture.path, digest(fixture.contents));
    }
    return declared;
  }

  /**
   * Splits what the worker touched into intended and unintended. A coding case has to
   * change its deliverable, so "nothing changed" is not a validity criterion; only a
   * change to a frozen file is. Extra files are reported, not disqualifying.
   */
  private async drift(workspace: string, declared: Map<string, string>, deliverables: ReadonlySet<string>): Promise<{ fixed: string[]; tampered: string[]; extra: string[] }> {
    const fixed: string[] = [];
    const tampered: string[] = [];
    const extra: string[] = [];
    for (const [fixture, expected] of declared) {
      let actual: string | undefined;
      try { actual = digest(await readFile(path.join(workspace, fixture), "utf8")); } catch { actual = undefined; }
      if (actual === expected) continue;
      (deliverables.has(fixture) ? fixed : tampered).push(fixture);
    }
    const declaredPaths = new Set(declared.keys());
    const list = async (dir: string): Promise<string[]> => {
      const { readdirSync } = await import("node:fs");
      const found: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
        if (entry.isDirectory()) found.push(...await list(path.join(dir, entry.name)));
        else if (entry.isFile()) found.push(path.relative(workspace, path.join(dir, entry.name)));
      }
      return found;
    };
    try { extra.push(...(await list(workspace)).filter(file => !declaredPaths.has(file))); } catch { /* workspace gone */ }
    return { fixed, tampered, extra };
  }

  /**
   * Proves the instrument before any worker time is spent: a case that already passes
   * measures nothing, and a case the reference fix cannot solve is unmeasurable. Both
   * were observed failures of a hand-built fixture, not hypothetical ones.
   */
  private async preflight(item: BenchmarkCase, dir: string): Promise<{ ok: boolean; reason?: string }> {
    const execute = this.options.execute ?? defaultExecute;
    const contract = item.acceptance ?? item.verifier;
    if (!contract) return { ok: true, reason: "keine harness-seitige Prüfung deklariert" };
    const broken = path.join(dir, "broken");
    await this.materialize(item, broken);
    const before = await execute(contract.replaceAll("{workspace}", broken), broken, this.options.caseTimeoutMs);
    if (before.exitCode === 0) return { ok: false, reason: "Fall ist ohne Worker-Änderung bereits gelöst - er misst nichts" };
    if (!item.referenceSolution) return { ok: true, reason: "Referenzlösung fehlt: Löslbarkeit ungeprüft" };
    const solved = path.join(dir, "solved");
    await this.materialize(item, solved, item.referenceSolution);
    if (item.acceptance) {
      const result = await execute(item.acceptance.replaceAll("{workspace}", solved), solved, this.options.caseTimeoutMs);
      if (result.exitCode !== 0) return { ok: false, reason: `Referenzlösung besteht acceptance nicht (Exit ${result.exitCode}): ${result.output.slice(-200)}` };
    }
    if (item.verifier) {
      const verifyDir = path.join(dir, "verifier");
      await mkdir(verifyDir, { recursive: true });
      const result = await execute(item.verifier.replaceAll("{workspace}", solved), verifyDir, this.options.caseTimeoutMs);
      if (result.exitCode !== 0) return { ok: false, reason: `Referenzlösung besteht Verifier nicht (Exit ${result.exitCode}): ${result.output.slice(-200)}` };
    }
    return { ok: true };
  }

  private async settle(taskId: string): Promise<ExecutionStatus | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.options.caseTimeoutMs); });
    timer?.unref?.();
    try {
      const settled = await Promise.race([this.dispatcher.waitForExecution(taskId).then(() => "settled" as const), deadline]);
      if (settled === "timeout") {
        await this.dispatcher.control(this.options.parent, taskId, "cancel").catch(() => undefined);
        return "timeout";
      }
      return this.dispatcher.list(this.options.parent).find(task => task.id === taskId)?.status ?? "cancelled";
    } finally {
      clearTimeout(timer);
    }
  }

  async run(suite: BenchmarkSuite, fingerprint: string, epoch: BenchmarkEpoch, onProgress?: (outcome: BenchmarkRunOutcome) => void): Promise<BenchmarkRunRecord> {
    const record: BenchmarkRunRecord = {
      id: `${suite.name}-${new Date(this.stamp()).toISOString().replace(/[:.]/g, "-")}`,
      suite: suite.name, fingerprint, epoch, startedAt: this.stamp(), outcomes: [],
    };
    const runDir = path.join(this.options.dir, record.id);
    await mkdir(runDir, { recursive: true });
    const mandate: NonNullable<Execution["dependency"]> = { taskId: record.id, depth: 0, original: `Benchmark suite ${suite.name}` };
    for (const schedule of benchmarkRuns(suite)) {
      const item = suite.cases.find(candidate => candidate.id === schedule.caseId)!;
      assertTaskIsolation(item);
      const workspace = path.join(runDir, "workspace", `${item.id}-${schedule.repeat}`);
      const privateRoot = path.join(runDir, "verify", `${item.id}-${schedule.repeat}`);
      const declared = await this.materialize(item, workspace);
      const requestId = `benchmark:${item.id}:${schedule.repeat}:${record.id}`;
      const started = this.stamp();
      const outcome: BenchmarkRunOutcome = {
        caseId: item.id, repeat: schedule.repeat, taskId: "", requestId,
        pin: { model: schedule.pin.model, thinking: schedule.pin.thinking },
        status: "ready", wallMs: 0, workspace, attempts: [], fixed: [], tampered: [], extra: [],
        pinMatches: false, verified: false,
      };
      record.outcomes.push(outcome);
      try {
        if (item.task.includes(runDir)) throw Error(`Benchmark case ${item.id} nennt den Laufordner im Task-Text`);
        const pre = await this.preflight(item, path.join(runDir, "preflight", `${item.id}-${schedule.repeat}`));
        outcome.preflight = { status: pre.ok ? "ok" : "failed", reason: pre.reason };
        if (!pre.ok) {
          outcome.status = "preflight-failed";
          outcome.diagnostic = `Preflight: ${pre.reason}`;
          onProgress?.(structuredClone(outcome));
          await this.save(record, runDir);
          continue;
        }
        const task = await this.dispatcher.submitScheduled(this.options.parent, requestId, this.taskText(item, workspace), mandate, schedule.pin);
        outcome.taskId = task.id;
        outcome.status = await this.settle(task.id);
      } catch (error) {
        outcome.status = "cancelled";
        outcome.diagnostic = error instanceof Error ? error.message : String(error);
      }
      outcome.wallMs = this.stamp() - started;
      const drift = await this.drift(workspace, declared, new Set(item.deliverables ?? []));
      outcome.fixed = drift.fixed;
      outcome.tampered = drift.tampered;
      outcome.extra = drift.extra;
      for (const sessionDir of locateWorkerSessionDirs(this.options.home, outcome.taskId))
        outcome.attempts.push(readWorkerMetrics(sessionDir));
      const bareModel = item.model.split("/").pop() ?? item.model;
      outcome.model = outcome.attempts[0]?.model;
      outcome.thinkingLevel = outcome.attempts[0]?.thinkingLevel;
      outcome.pinMatches = outcome.attempts.length > 0 && outcome.attempts.every(
        attempt => attempt.model === bareModel && attempt.thinkingLevel === item.thinking);
      const execute = this.options.execute ?? defaultExecute;
      if (item.acceptance) {
        const result = await execute(item.acceptance.replaceAll("{workspace}", workspace), workspace, this.options.caseTimeoutMs);
        outcome.acceptance = { command: item.acceptance, exitCode: result.exitCode, outputTail: result.output.slice(-1_000) };
      }
      if (item.verifier) {
        // Runs from a private directory outside the workspace: the worker never reads the contract check.
        const privateDir = privateRoot;
        await mkdir(privateDir, { recursive: true });
        const result = await execute(item.verifier.replaceAll("{workspace}", workspace), privateDir, this.options.caseTimeoutMs);
        outcome.verifier = { command: item.verifier, exitCode: result.exitCode, outputTail: result.output.slice(-1_000) };
      }
      const acceptanceOk = item.acceptance
        ? outcome.acceptance?.exitCode === 0
        : Boolean(this.dispatcher.list(this.options.parent).find(task => task.id === outcome.taskId)?.result);
      const verifierOk = item.verifier ? outcome.verifier?.exitCode === 0 : true;
      outcome.verified = outcome.status === "completed" && outcome.tampered.length === 0
        && outcome.pinMatches && acceptanceOk && verifierOk;
      if (!outcome.verified && !outcome.diagnostic) {
        if (!outcome.pinMatches) outcome.diagnostic = `Pin-Abgleich: beobachtet ${outcome.model ?? "unbekannt"}/${outcome.thinkingLevel ?? "unbekannt"}, erwartet ${bareModel}/${item.thinking}`;
        else if (outcome.tampered.length) outcome.diagnostic = `eingefrorene Dateien geändert: ${outcome.tampered.join(", ")}`;
        else if (!verifierOk) outcome.diagnostic = `Verifier Exit ${outcome.verifier?.exitCode ?? "unbekannt"}`;
        else if (!acceptanceOk) outcome.diagnostic = `Acceptance Exit ${outcome.acceptance?.exitCode ?? "ohne Ergebnis"}`;
      }
      onProgress?.(structuredClone(outcome));
      await this.save(record, runDir);
    }
    record.finishedAt = this.stamp();
    await this.save(record, runDir);
    return record;
  }

  private async save(record: BenchmarkRunRecord, runDir: string): Promise<void> {
    const target = path.join(runDir, "record.json");
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2));
    await rename(temporary, target);
  }
}
