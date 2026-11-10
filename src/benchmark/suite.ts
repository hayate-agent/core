import { createHash } from "node:crypto";
import { validateWorkerPin, type ThinkingLevel } from "../model-roles.js";

/**
 * A benchmark case is data, not code: the suite is operator authored and the
 * runner materialises it. Expectations live on the harness side only - a worker
 * that can read the parent transcript must not be able to read the answer key
 * out of its own task text.
 */
export interface BenchmarkFixtureFile { path: string; contents: string }

export interface BenchmarkCase {
  id: string;
  /** Task text handed to the worker. Must not contain the expectation. */
  task: string;
  model: string;
  thinking: ThinkingLevel;
  fixtures: BenchmarkFixtureFile[];
  /** Harness-side shell check; exit code 0 means the case passed. {workspace} expands to the worker directory. */
  acceptance?: string;
  /** Files the worker is expected to change. A change to any other fixture is tampering. */
  deliverables?: string[];
  /**
   * Contract check executed from a private directory outside the worker workspace, so a
   * worker that can reach the shared filesystem still cannot read how it is graded.
   * {workspace} expands to the worker directory.
   */
  verifier?: string;
  /**
   * Reference fix applied only during the preflight to prove the case is solvable. Never
   * materialised into the worker workspace.
   */
  referenceSolution?: BenchmarkFixtureFile[];
  /** Expected observable outcome, kept out of the worker task text. */
  expectation?: string;
  repeats?: number;
}

export interface BenchmarkSuite { name: string; repeats: number; cases: BenchmarkCase[] }

export interface BenchmarkRun { caseId: string; repeat: number; pin: { model: string; thinking: ThinkingLevel } }

const LIMITS = { task: 64_000, contents: 200_000, cases: 64, repeats: 20, id: 80, name: 120, acceptance: 4_000 };

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Error(`Invalid benchmark ${field}`);
  return value;
}

/** Fixtures are materialised below the run directory; absolute or escaping paths are rejected. */
function relativePath(value: unknown, id: string): string {
  const path = text(value, `fixture path of ${id}`, 400).replace(/\\/g, "/");
  if (path.startsWith("/") || path.startsWith("~") || /^[a-zA-Z]:/.test(path)) throw Error(`Benchmark fixture path must be relative: ${path}`);
  if (path.split("/").some(part => part === ".." || part === "" )) throw Error(`Benchmark fixture path escapes the run directory: ${path}`);
  return path;
}

function safeId(value: unknown): string {
  const id = text(value, "case id", LIMITS.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw Error(`Invalid benchmark case id: ${id}`);
  return id;
}

export function parseBenchmarkSuite(value: unknown): BenchmarkSuite {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid benchmark suite");
  const suite = value as Record<string, unknown>;
  const known = ["name", "repeats", "cases"];
  if (Object.keys(suite).some(key => !known.includes(key))) throw Error("Invalid benchmark suite: unknown setting");
  const name = text(suite.name, "suite name", LIMITS.name);
  const repeats = suite.repeats === undefined ? 3 : suite.repeats;
  if (!Number.isInteger(repeats) || (repeats as number) < 1 || (repeats as number) > LIMITS.repeats) throw Error("Invalid benchmark repeats");
  if (!Array.isArray(suite.cases) || !suite.cases.length || suite.cases.length > LIMITS.cases) throw Error("Invalid benchmark cases");
  const seen = new Set<string>();
  const cases = suite.cases.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("Invalid benchmark case");
    const entry = item as Record<string, unknown>;
    const allowed = ["id", "task", "model", "thinking", "fixtures", "acceptance", "deliverables", "verifier", "referenceSolution", "expectation", "repeats"];
    if (Object.keys(entry).some(key => !allowed.includes(key))) throw Error("Invalid benchmark case: unknown setting");
    const id = safeId(entry.id);
    if (seen.has(id)) throw Error(`Duplicate benchmark case id: ${id}`);
    seen.add(id);
    // Reuse the dispatcher pin contract so a suite can never express a pair the
    // runtime could silently fall back from.
    const pin: unknown = { model: text(entry.model, `model of ${id}`, 200), thinking: entry.thinking };
    validateWorkerPin(pin);
    const rawFixtures = entry.fixtures ?? [];
    if (!Array.isArray(rawFixtures)) throw Error(`Invalid benchmark fixtures of ${id}`);
    const fixtures = rawFixtures.map(file => {
      if (!file || typeof file !== "object" || Array.isArray(file)) throw Error(`Invalid benchmark fixture of ${id}`);
      const record = file as Record<string, unknown>;
      if (Object.keys(record).some(key => !["path", "contents"].includes(key))) throw Error(`Invalid benchmark fixture of ${id}: unknown setting`);
      return { path: relativePath(record.path, id), contents: typeof record.contents === "string" ? record.contents : "" };
    });
    const paths = fixtures.map(file => file.path);
    if (new Set(paths).size !== paths.length) throw Error(`Duplicate benchmark fixture in ${id}`);
    const caseRepeats = entry.repeats;
    if (caseRepeats !== undefined && (!Number.isInteger(caseRepeats) || (caseRepeats as number) < 1 || (caseRepeats as number) > LIMITS.repeats)) throw Error(`Invalid benchmark repeats of ${id}`);
    // A deliverable has to be a declared fixture: otherwise a run could "fix" a file nobody owns.
    let deliverables: string[] | undefined;
    if (entry.deliverables !== undefined) {
      if (!Array.isArray(entry.deliverables) || !entry.deliverables.length) throw Error(`Invalid benchmark deliverables of ${id}`);
      deliverables = entry.deliverables.map(value => relativePath(value, id));
      if (new Set(deliverables).size !== deliverables.length) throw Error(`Duplicate benchmark deliverable of ${id}`);
      for (const file of deliverables) if (!paths.includes(file)) throw Error(`Benchmark deliverable ${file} of ${id} is not a fixture`);
    }
    // The reference fix may only touch declared fixtures, and has to be a real solution.
    let referenceSolution: BenchmarkFixtureFile[] | undefined;
    if (entry.referenceSolution !== undefined) {
      if (!Array.isArray(entry.referenceSolution) || !entry.referenceSolution.length) throw Error(`Invalid benchmark reference solution of ${id}`);
      referenceSolution = entry.referenceSolution.map(file => {
        if (!file || typeof file !== "object" || Array.isArray(file)) throw Error(`Invalid benchmark reference solution file of ${id}`);
        const record = file as Record<string, unknown>;
        if (Object.keys(record).some(key => !(["path", "contents"] as string[]).includes(key))) throw Error(`Invalid benchmark reference solution of ${id}: unknown setting`);
        return { path: relativePath(record.path, id), contents: typeof record.contents === "string" ? record.contents : "" };
      });
      const refPaths = referenceSolution.map(file => file.path);
      if (new Set(refPaths).size !== refPaths.length) throw Error(`Duplicate benchmark reference solution file of ${id}`);
      for (const file of refPaths) if (!paths.includes(file)) throw Error(`Benchmark reference solution file ${file} of ${id} is not a fixture`);
    }
    return {
      id,
      task: text(entry.task, `task of ${id}`, LIMITS.task),
      model: pin.model,
      thinking: pin.thinking,
      fixtures,
      ...(entry.acceptance === undefined ? {} : { acceptance: text(entry.acceptance, `acceptance of ${id}`, LIMITS.acceptance) }),
      ...(deliverables === undefined ? {} : { deliverables }),
      ...(entry.verifier === undefined ? {} : { verifier: text(entry.verifier, `verifier of ${id}`, LIMITS.acceptance) }),
      ...(referenceSolution === undefined ? {} : { referenceSolution }),
      ...(entry.expectation === undefined ? {} : { expectation: text(entry.expectation, `expectation of ${id}`, LIMITS.task) }),
      ...(caseRepeats === undefined ? {} : { repeats: caseRepeats as number }),
    } satisfies BenchmarkCase;
  });
  return { name, repeats: repeats as number, cases };
}

/** Flattened serial schedule. Runs stay one-at-a-time: parallel workers share one GPU and only get slower. */
export function benchmarkRuns(suite: BenchmarkSuite): BenchmarkRun[] {
  const runs: BenchmarkRun[] = [];
  for (const item of suite.cases)
    for (let repeat = 1; repeat <= (item.repeats ?? suite.repeats); repeat++)
      runs.push({ caseId: item.id, repeat, pin: { model: item.model, thinking: item.thinking } });
  return runs;
}

/** A run is only comparable to another run from the same suite *and* the same infrastructure epoch. */
export function suiteFingerprint(suite: BenchmarkSuite, epoch: Record<string, string | number> = {}): string {
  const canonical = JSON.stringify({ suite: suite.name, repeats: suite.repeats, epoch, cases: suite.cases.map(item => [
    item.id, item.task, item.model, item.thinking, item.acceptance ?? "", item.expectation ?? "", item.repeats ?? suite.repeats,
    item.deliverables ?? [], item.verifier ?? "",
    (item.referenceSolution ?? []).map(file => [file.path, createHash("sha256").update(file.contents).digest("hex")]),
    item.fixtures.map(file => [file.path, createHash("sha256").update(file.contents).digest("hex")]),
  ]) });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Contamination guard: the worker decides what it writes, and we measured that a
 * worker will go looking for the answer key in files it can reach. The task text
 * must therefore never carry the expected outcome.
 */
export function assertTaskIsolation(item: BenchmarkCase): void {
  if (item.expectation) {
    const needle = item.expectation.trim().toLowerCase();
    if (needle && item.task.toLowerCase().includes(needle)) throw Error(`Benchmark case ${item.id} leaks its expectation into the task text`);
  }
  // The verifier is the hidden grader: quoting it would let a worker special-case it.
  // The acceptance command is different - telling the worker "make node test.js pass" is
  // the normal way to state a coding task, and that test is frozen either way.
  if (item.verifier && item.task.includes(item.verifier))
    throw Error(`Benchmark case ${item.id} leaks its verifier into the task text`);
}
