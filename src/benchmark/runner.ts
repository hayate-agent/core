import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Execution, ExecutionStatus } from "../execution.js";
import type { BenchmarkEpoch } from "./epoch.js";
import { locateWorkerSessionDirs, readWorkerMetrics, type WorkerMetrics } from "./metrics.js";
import { assertTaskIsolation, benchmarkRuns, type BenchmarkCase, type BenchmarkSuite } from "./suite.js";

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
  status: ExecutionStatus | "timeout";
  /** Wall clock including queueing; metrics durationMs is model time only. */
  wallMs: number;
  workspace: string;
  attempts: WorkerMetrics[];
  acceptance?: BenchmarkAcceptance;
  /** Files the worker changed that the suite declared; always reported, never silently accepted. */
  fixtureDrift: string[];
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
  /** Directory holding run records and materialised fixtures. */
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

  private async materialize(item: BenchmarkCase, workspace: string): Promise<Map<string, string>> {
    await mkdir(workspace, { recursive: true });
    const declared = new Map<string, string>();
    for (const fixture of item.fixtures) {
      const target = path.join(workspace, fixture.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, fixture.contents);
      declared.set(fixture.path, digest(fixture.contents));
    }
    return declared;
  }

  private async drift(workspace: string, declared: Map<string, string>): Promise<string[]> {
    const changed: string[] = [];
    for (const [fixture, expected] of declared) {
      try {
        if (digest(await readFile(path.join(workspace, fixture), "utf8")) !== expected) changed.push(fixture);
      } catch {
        changed.push(`${fixture} (missing)`);
      }
    }
    return changed;
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
    const runDir = path.join(this.options.dir, "runs", record.id);
    await mkdir(runDir, { recursive: true });
    const mandate: NonNullable<Execution["dependency"]> = { taskId: record.id, depth: 0, original: `Benchmark suite ${suite.name}` };
    for (const schedule of benchmarkRuns(suite)) {
      const item = suite.cases.find(candidate => candidate.id === schedule.caseId)!;
      assertTaskIsolation(item);
      const workspace = path.join(runDir, "workspace", `${item.id}-${schedule.repeat}`);
      const declared = await this.materialize(item, workspace);
      const requestId = `benchmark:${item.id}:${schedule.repeat}:${record.id}`;
      const started = this.stamp();
      const outcome: BenchmarkRunOutcome = {
        caseId: item.id, repeat: schedule.repeat, taskId: "", requestId,
        pin: { model: schedule.pin.model, thinking: schedule.pin.thinking },
        status: "ready", wallMs: 0, workspace, attempts: [], fixtureDrift: [], verified: false,
      };
      record.outcomes.push(outcome);
      try {
        const task = await this.dispatcher.submitScheduled(this.options.parent, requestId, this.taskText(item, workspace), mandate, schedule.pin);
        outcome.taskId = task.id;
        outcome.status = await this.settle(task.id);
      } catch (error) {
        outcome.status = "cancelled";
        outcome.diagnostic = error instanceof Error ? error.message : String(error);
      }
      outcome.wallMs = this.stamp() - started;
      outcome.fixtureDrift = await this.drift(workspace, declared);
      for (const sessionDir of locateWorkerSessionDirs(this.options.home, outcome.taskId))
        outcome.attempts.push(readWorkerMetrics(sessionDir));
      if (item.acceptance) {
        const execute = this.options.execute ?? defaultExecute;
        const result = await execute(item.acceptance, workspace, this.options.caseTimeoutMs);
        outcome.acceptance = { command: item.acceptance, exitCode: result.exitCode, outputTail: result.output.slice(-1_000) };
      }
      outcome.verified = outcome.status === "completed" && outcome.fixtureDrift.length === 0
        && (outcome.acceptance ? outcome.acceptance.exitCode === 0 : Boolean(this.dispatcher.list(this.options.parent).find(task => task.id === outcome.taskId)?.result));
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
