// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileDurable } from "./durable.js";
import { runExperimentProcess } from "./experiment-process.js";

const exec = promisify(execFile);
export interface ExperimentSpec {
  baseline: string;
  candidate: string;
  hypothesis: string;
  metric: string;
  direction: "lower" | "higher";
  minimumDelta: number;
}
export interface Measurement { score: number; checksPassed: boolean }
export interface ExperimentResult {
  id: string;
  spec: ExperimentSpec;
  runnerHash: string;
  baseline?: Measurement;
  candidate?: Measurement;
  verdict: "improved" | "rejected" | "inconclusive";
  reason: string;
  /** Internal recovery paths only; never runner output or raw error messages. */
  cleanup?: { complete: boolean; remainingWorktrees: string[]; retainedRoot?: string };
}
function measurement(stdout: string): Measurement {
  const value = JSON.parse(stdout);
  if (!value || typeof value.score !== "number" || !Number.isFinite(value.score) || typeof value.checksPassed !== "boolean") throw Error("Invalid evaluator output");
  return { score: value.score, checksPassed: value.checksPassed };
}
/** Trusted evaluator is supplied by infrastructure, never selected by a model argument.
 * It receives one detached worktree path and returns {score, checksPassed} as JSON.
 * Worktrees isolate Git changes, NOT OS permissions or executable candidate code.
 */
export class ExperimentEvaluator {
  private running = false;
  constructor(private repository: string, private evidenceDir: string, private runner: string, private runnerSha256: string, private timeoutMs = 120000) {}
  async evaluate(spec: ExperimentSpec): Promise<ExperimentResult> {
    if (this.running) throw Error("Experiment evaluator busy");
    this.running = true;
    try { return await this.evaluateReserved(spec); }
    finally { this.running = false; }
  }
  private async evaluateReserved(spec: ExperimentSpec): Promise<ExperimentResult> {
    if (![spec.baseline, spec.candidate].every((s) => /^[a-f0-9]{40}$/.test(s)) || spec.baseline === spec.candidate || !spec.hypothesis?.trim() || spec.hypothesis.length > 2000 || !/^[a-zA-Z0-9_.-]{1,80}$/.test(spec.metric) || !["lower", "higher"].includes(spec.direction) || !Number.isFinite(spec.minimumDelta) || spec.minimumDelta < 0) throw Error("Invalid experiment specification");
    if (!path.isAbsolute(this.runner) || !/^[a-f0-9]{64}$/.test(this.runnerSha256)) throw Error("Invalid trusted evaluator configuration");
    const runnerSource = await readFile(this.runner, "utf8");
    const runnerHash = createHash("sha256").update(runnerSource).digest("hex");
    if (runnerHash !== this.runnerSha256) throw Error("Evaluator integrity mismatch");
    const result: ExperimentResult = { id: randomUUID(), spec: structuredClone(spec), runnerHash, verdict: "inconclusive", reason: "Evaluation did not complete" };
    let root: string | undefined;
    const worktrees: string[] = [];
    const git = (args: string[]) => exec("git", ["-C", this.repository, ...args], { timeout: this.timeoutMs, maxBuffer: 65536 });
    try {
      root = await mkdtemp(path.join(os.tmpdir(), "harness-experiment-"));
      // Run the same captured evaluator bytes for both revisions, without shell expansion.
      const evaluator = path.join(root, "evaluator.mjs");
      await writeFileDurable(evaluator, runnerSource);
      await mkdir(this.evidenceDir, { recursive: true, mode: 0o700 });
      await writeFileDurable(path.join(this.evidenceDir, result.id + ".json"), JSON.stringify(result));
      for (const side of ["baseline", "candidate"] as const) {
        await git(["cat-file", "-e", spec[side] + "^{commit}"]);
        const directory = path.join(root, side);
        worktrees.push(directory); // add can register before a later checkout failure
        await git(["worktree", "add", "--detach", directory, spec[side]]);
        const { stdout } = await runExperimentProcess(process.execPath, [evaluator, directory, spec.metric], { cwd: root, timeout: this.timeoutMs, maxBuffer: 65536 });
        result[side] = measurement(stdout);
      }
      if (!result.baseline!.checksPassed) result.reason = "Baseline checks failed; comparison invalid";
      else if (!result.candidate!.checksPassed) { result.verdict = "rejected"; result.reason = "Candidate regression checks failed"; }
      else {
        const delta = (result.candidate!.score - result.baseline!.score) * (spec.direction === "higher" ? 1 : -1);
        result.verdict = delta > 0 && delta >= spec.minimumDelta ? "improved" : "rejected";
        result.reason = result.verdict === "improved" ? "Measured improvement meets threshold; review still required before adoption" : "No sufficient measured improvement";
      }
    } catch { result.verdict = "inconclusive"; result.reason = "Evaluator failed, timed out or returned invalid evidence"; }
    finally {
      const remainingWorktrees: string[] = [];
      for (const directory of worktrees) {
        try { await git(["worktree", "remove", "--force", directory]); }
        catch {
          // A failed add may never have registered the path. Only discard its
          // recovery entry when the authoritative registry proves it absent.
          try {
            const { stdout } = await git(["worktree", "list", "--porcelain", "-z"]);
            const registered = stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => path.resolve(field.slice(9)));
            if (!registered.length || registered.includes(path.resolve(directory))) remainingWorktrees.push(directory);
          } catch { remainingWorktrees.push(directory); }
        }
      }
      let retainedRoot = root;
      if (!remainingWorktrees.length && root) {
        try { await rm(root, { recursive: true, force: true }); retainedRoot = undefined; }
        catch { /* Preserve recovery location without leaking subprocess errors. */ }
      }
      const complete = !remainingWorktrees.length && !retainedRoot;
      result.cleanup = { complete, remainingWorktrees, ...(retainedRoot ? { retainedRoot } : {}) };
      if (!complete) {
        result.verdict = "inconclusive";
        result.reason = "Experiment cleanup incomplete; operator recovery required";
      }
    }
    await writeFileDurable(path.join(this.evidenceDir, result.id + ".json"), JSON.stringify(result));
    return result;
  }
}
