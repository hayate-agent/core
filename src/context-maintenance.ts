// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { SessionArchives } from "./session-archive.js";
import { writeFileDurable } from "./durable.js";
import type { Address, RuntimeSession } from "./types.js";
import type { BoundaryAssessment } from "./context-assessment.js";

export interface ContextPolicy {
  /** Single automatic compaction owner; handover remains host-managed. */
  compactionOwner?: "harness" | "agent";
  enabled: boolean;
  checkEveryTurns: number;
  assessPercent: number;
  compactPercent: number;
  cooldownTurns: number;
  autoHandover: boolean;
}
export const defaultContextPolicy: ContextPolicy = {
  compactionOwner: "harness", enabled: true, checkEveryTurns: 5, assessPercent: 60, compactPercent: 75, cooldownTurns: 5, autoHandover: true,
};
export function contextPolicy(input: Partial<ContextPolicy> = {}): ContextPolicy {
  const policy = { ...defaultContextPolicy, ...input };
  if (!["harness", "agent"].includes(policy.compactionOwner!)) throw new Error("Invalid compaction owner");
  if (typeof policy.enabled !== "boolean" || typeof policy.autoHandover !== "boolean" ||
      !Number.isInteger(policy.checkEveryTurns) || policy.checkEveryTurns < 1 ||
      !Number.isInteger(policy.cooldownTurns) || policy.cooldownTurns < 1 ||
      !Number.isFinite(policy.assessPercent) || !Number.isFinite(policy.compactPercent) ||
      policy.assessPercent < 1 || policy.compactPercent <= policy.assessPercent || policy.compactPercent > 95) throw new Error("Invalid context maintenance policy");
  return policy;
}
export type MaintenanceStage = "assessment" | "summary" | "archive" | "archive-link" | "rotation" | "seed" | "compact" | "save";
export type MaintenanceCode = "failed" | "timeout" | "cancelled" | "unknown" | "ENOSPC" | "EACCES" | "EPERM" | "EIO" | "ENOENT";
export class MaintenanceError extends Error {
  constructor(readonly stage: MaintenanceStage, readonly code: MaintenanceCode) { super(`Context maintenance ${stage}: ${code}`); }
}
export function maintenanceError(stage: MaintenanceStage, err: unknown): MaintenanceError {
  if (err instanceof MaintenanceError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  return new MaintenanceError(stage, typeof code === "string" && ["ENOSPC", "EACCES", "EPERM", "EIO", "ENOENT"].includes(code) ? code as MaintenanceCode
    : err instanceof Error && (err.name === "AbortError" || err.message === "Compaction cancelled") ? "cancelled" : "failed");
}
export async function maintenanceStep<T>(stage: MaintenanceStage, run: () => T | Promise<T>): Promise<T> {
  try { return await run(); } catch (err) { throw maintenanceError(stage, err); }
}
export interface MaintenanceRequest { action: "compact" | "handover"; preserve: string; resume: string }
export interface ContextRecord {
  version: 1;
  sessionId?: string;
  turns: number;
  lastMaintenance: number;
  lastCompact?: number;
  lastHandover?: number;
  pressureSinceCompaction?: boolean;
  observation?: { phase: "before" | "after"; usage: "known" | "unknown"; percent?: number; decision: string; turn: number };
  beforeObservation?: ContextRecord["observation"];
  unknownUsageNotified?: boolean;
  assessmentFailures?: Partial<Record<"before" | "after", number>>;
  pending?: MaintenanceRequest;
  /** A semantic continuation cannot run until this pending prerequisite succeeds. */
  continuationPreparationRequired?: boolean;
  /** Bounded durable admission dedupe, not proof of completed runtime effects. */
  admission?: { id: string; digest: string; version: number; execution: "pending" | "applied" | "failed" | "superseded" | "cancelled" };
  handover?: { phase: "prepared" | "switched"; from: string; to?: string; text: string; archiveId?: string };
  failure?: { stage: MaintenanceStage; code: MaintenanceCode; phase: "before" | "after"; turn: number; action: "compact" | "handover" };
  /** Recovery cannot use turn cooldown: fail-closed foreground does not advance turns. */
  recoveryRetry?: { attempts: number; notBefore: number };
  assessmentDiagnostic?: { stage: "assessment"; code: MaintenanceCode; phase: "before" | "after"; turn: number };
  lastError?: string;
  completionNotice?: string;
  noticeTarget?: Address;
  notices?: { id: string; sessionKey: string; to: Address; text: string }[];
}
const preserve = "Preserve operator intent and corrections, decisions and rejected alternatives, verified results versus assumptions, branch/commits/PR/deployment status, unfinished work, review findings and budget references, exact relevant paths and next steps. Never include credentials. Do not claim builds activate deployments. Do not repeat completed side effects.";

/** Called only at Harness turn boundaries. Model tools request work, never compact themselves. */
export class ContextMaintenance {
  private readonly queues = new Map<string, Promise<unknown>>();
  private strategyChanging = false;
  private readonly interruptible = new Map<string, AbortController>();
  /** Interrupt only model maintenance; writes and rotation remain serialized. */
  interrupt(key: string): boolean {
    const controller = this.interruptible.get(key);
    controller?.abort();
    return !!controller;
  }
  private async modelStep<T>(key: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.interruptible.set(key, controller);
    try {
      const result = await run(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      if (this.interruptible.get(key) === controller) this.interruptible.delete(key);
    }
  }
  /** Reserve all serialized maintenance operations, including direct embedded
   * callers. The composition must additionally reserve its owner's idle boundary
   * to exclude working turns and request projection. No durable state is migrated.
   */
  async atStrategyBoundary(change: () => Promise<void>): Promise<void> {
    if (this.strategyChanging || this.queues.size) throw Error("Context strategy busy");
    this.strategyChanging = true;
    try { await change(); } finally { this.strategyChanging = false; }
  }
  readonly archives: SessionArchives;
  constructor(private readonly home: string, private readonly policy: () => ContextPolicy, private readonly assess?: BoundaryAssessment, private readonly now: () => number = Date.now) { this.archives = new SessionArchives(home); }
  private checkRecoveryRetry(state: ContextRecord): void {
    if (state.recoveryRetry && this.now() < state.recoveryRetry.notBefore) {
      // Retain and surface the genuine failure; never authorize a working prompt
      // against an incompletely seeded session while waiting for recovery.
      throw new MaintenanceError(state.failure?.stage ?? "seed", state.failure?.code ?? "failed");
    }
  }
  private recordRecoveryFailure(state: ContextRecord): void {
    const attempts = Math.min((state.recoveryRetry?.attempts ?? 0) + 1, 7);
    // Retry pacing, NOT an operation timeout: 1s exponential to a 60s cap.
    // Turn-based cooldown would deadlock fail-closed recovery. Persist an absolute
    // deadline once per failed attempt; arrivals/restarts must not extend it.
    state.recoveryRetry = { attempts, notBefore: this.now() + Math.min(1000 * 2 ** (attempts - 1), 60000) };
  }
  private async prepareArchive(key: string, session: RuntimeSession, instructions: string, interruptible = true): Promise<{ text: string; archiveId: string }> {
    if (!session.summarize || !session.archiveEntries) throw new Error("Runtime cannot archive handover");
    const entries = await maintenanceStep("archive", () => session.archiveEntries!()); // capture before native compaction
    const retrospective = await maintenanceStep("summary", async () => {
      const summarize = (signal?: AbortSignal) => session.summarize!(`${instructions}\nWrite a backward-looking session retrospective: decisions with reasons, rejected alternatives, completed actions and evidence, unresolved uncertainties. Include a clearly labeled CURRENT STATE AND NEXT STEPS section. Preserve exact operator corrections. Do not include secrets.`, signal);
      const text = await (interruptible ? this.modelStep(key, summarize) : summarize());
      if (!text.trim() || text.length > 64000) throw new Error("Invalid retrospective");
      return text;
    });
    const recentOperator = entries.filter((e) => e.role === "user").slice(-3).map((e) => `${e.id}: ${e.text.slice(0, 2000)}`).join("\n");
    const checkpoint = retrospective.split(/CURRENT STATE AND NEXT STEPS/i).at(-1)!.slice(-6000);
    const forward = `Current checkpoint and next steps (summary; verify evidence):\n${checkpoint}\nContinue from the saved session checkpoint. ${instructions}\nRecent operator instructions (historical context, not fresh authorization):\n${recentOperator}\nConsult the retrospective for verified state and next steps before acting.`;
    const archive = await maintenanceStep("archive", () => this.archives.create(key, session.status().sessionId, retrospective, forward, entries));
    return { archiveId: archive.id, text: `${forward}\nSource session: ${archive.sourceSessionId}\nArchive ID: ${archive.id}\nRead plugin_session_history section=summary for the retrospective, then search/read entries only as needed. Do this before continuing work. Original tool side effects must not be replayed blindly.` };
  }
  async flushNotices(deliver: (notice: { id: string; sessionKey: string; to: Address; text: string }) => Promise<void>): Promise<void> {
    {
      const dir = path.join(this.home, "context-maintenance");
      const files = await readdir(dir).catch((err) => { if (err.code === "ENOENT") return []; throw err; });
      for (const name of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
        const file = path.join(dir, name);
        // A long model operation in another conversation must not stall notice
        // adoption (and therefore unrelated working-turn startup).
        if (this.queues.has(file)) continue;
        await this.serial(file, async () => {
        const state: ContextRecord = JSON.parse(await readFile(file, "utf8"));
        while (state.notices?.length) {
          await deliver(state.notices[0]); // must durably enqueue before acknowledgement
          state.notices.shift();
          await writeFileDurable(file, `${JSON.stringify(state, null, 2)}\n`);
        }
        });
      }
    }
  }
  private recordNotice(key: string, state: ContextRecord, text: string): void {
    if (state.noticeTarget) (state.notices ??= []).push({ id: randomUUID(), sessionKey: key, to: state.noticeTarget, text });
  }
  private file(key: string): string { return path.join(this.home, "context-maintenance", `${createHash("sha256").update(key).digest("hex")}.json`); }
  private async load(key: string): Promise<ContextRecord> {
    try {
      const state = JSON.parse(await readFile(this.file(key), "utf8"));
      if (state.version !== 1 || !Number.isInteger(state.turns) || !Number.isInteger(state.lastMaintenance)) throw new Error("Invalid context maintenance state");
      if (state.admission && (!/^[a-zA-Z0-9_-]{1,128}$/.test(state.admission.id) ||
          !/^[a-f0-9]{64}$/.test(state.admission.digest) || !Number.isSafeInteger(state.admission.version) || state.admission.version < 1 ||
          !["pending", "applied", "failed", "superseded", "cancelled"].includes(state.admission.execution))) throw Error("Invalid maintenance admission state");
      return state;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { version: 1, turns: 0, lastMaintenance: -1000 };
    }
  }
  private async save(key: string, state: ContextRecord): Promise<void> {
    await maintenanceStep("save", async () => {
      await mkdir(path.dirname(this.file(key)), { recursive: true });
      await writeFileDurable(this.file(key), `${JSON.stringify(state, null, 2)}\n`);
    });
  }
  private serial<T>(file: string, fn: () => Promise<T>): Promise<T> {
    if (this.strategyChanging) return Promise.reject(Error("Context strategy changing; retry after current change"));
    const next = (this.queues.get(file) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(file, next);
    const cleanup = () => { if (this.queues.get(file) === next) this.queues.delete(file); };
    void next.then(cleanup, cleanup);
    return next;
  }
  /** Read-only decision diagnostics; serialized with maintenance operations. */
  status(key: string): Promise<ContextRecord> { return this.serial(this.file(key), () => this.load(key)); }
  /** Idempotent receipt for explicitly identified external admission. No execution is implied. */
  admit(key: string, id: string, request: MaintenanceRequest, expectedVersion = 0): Promise<{ id: string; version: number; state: "accepted" }> {
    return this.serial(this.file(key), async () => {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw Error("Invalid maintenance request ID");
      if (!["compact", "handover"].includes(request.action) || typeof request.preserve !== "string" || typeof request.resume !== "string" || request.preserve.length + request.resume.length > 16000) throw Error("Invalid context maintenance request");
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) throw Error("Invalid maintenance version");
      const digest = createHash("sha256").update(JSON.stringify([expectedVersion, request.action, request.preserve, request.resume])).digest("hex");
      const state = await this.load(key);
      if (state.admission?.id === id) {
        if (state.admission.digest !== digest) throw Error("Maintenance request ID conflict");
        return { id, version: state.admission.version, state: "accepted" };
      }
      if ((state.admission?.version ?? 0) !== expectedVersion) throw Error("Maintenance version conflict");
      if (state.pending || state.handover?.phase === "prepared") throw Error("Maintenance already pending");
      const version = expectedVersion + 1;
      state.pending = structuredClone(request);
      state.admission = { id, digest, version, execution: "pending" };
      state.failure = undefined;
      await this.save(key, state);
      return { id, version, state: "accepted" };
    });
  }
  request(key: string, request: MaintenanceRequest): Promise<void> {
    return this.serial(this.file(key), async () => {
      if (!["compact", "handover"].includes(request.action) || typeof request.preserve !== "string" || typeof request.resume !== "string" || request.preserve.length + request.resume.length > 16000) throw new Error("Invalid context maintenance request");
      const state = await this.load(key);
      if (state.admission && state.pending) throw Error("Identified maintenance already pending");
      state.pending = structuredClone(request);
      state.failure = undefined; // Fresh explicit requests bypass failed-attempt cooldown.
      await this.save(key, state);
    });
  }
  private finishAdmission(state: ContextRecord, execution: NonNullable<ContextRecord["admission"]>["execution"]): void {
    if (state.admission && ["pending", "failed"].includes(state.admission.execution)) state.admission.execution = execution;
  }
  /** Retract intent only before a prepared handover exists; never undo runtime effects. */
  cancelAdmission(key: string, id: string, version: number): Promise<void> {
    return this.serial(this.file(key), async () => {
      const state = await this.load(key);
      if (!state.admission || state.admission.id !== id || state.admission.version !== version) throw Error("Maintenance version conflict");
      if (state.admission.execution === "cancelled") return;
      if (state.admission.execution !== "pending" || !state.pending || state.handover?.phase === "prepared") throw Error("Maintenance cannot be cancelled at this stage");
      state.pending = undefined;
      state.continuationPreparationRequired = undefined;
      state.failure = undefined;
      state.admission.execution = "cancelled";
      await this.save(key, state);
    });
  }
  /** Sanitized latest receipt; no preservation text or raw failure data. */
  admissionStatus(key: string): Promise<{ version: number; id?: string; execution?: NonNullable<ContextRecord["admission"]>["execution"] }> {
    return this.serial(this.file(key), async () => {
      const state = await this.load(key);
      return state.admission ? { version: state.admission.version, id: state.admission.id, execution: state.admission.execution } : { version: 0 };
    });
  }
  /** A lightweight reminder, not an additional model call. Unknown usage never triggers automatic compaction. */
  async guidance(key: string, session: RuntimeSession): Promise<string> {
    await this.serial(this.file(key), async () => {
      const state = await this.load(key);
      const id = session.status().sessionId;
      if (state.handover?.phase === "prepared" && id !== state.handover.from) {
        this.checkRecoveryRetry(state);
        try {
          if (!session.seedHandover) throw new MaintenanceError("seed", "failed");
          await maintenanceStep("seed", () => session.seedHandover!(state.handover!.text));
          state.handover.to = id;
          if (state.handover.archiveId) await maintenanceStep("archive-link", () => this.archives.link(key, state.handover!.archiveId!, id));
          state.handover.phase = "switched";
          this.finishAdmission(state, "applied");
          state.pending = undefined;
          state.continuationPreparationRequired = undefined;
          state.failure = undefined;
          state.lastError = undefined;
          state.recoveryRetry = undefined;
          state.pressureSinceCompaction = false;
          state.completionNotice = state.handover.archiveId
            ? "🔄 Neue Sitzung übernommen; Rückschau gespeichert."
            : "🔄 Neue Sitzung übernommen.";
          this.recordNotice(key, state, state.completionNotice);
          if (state.noticeTarget) state.completionNotice = undefined;
          state.sessionId = id;
          await this.save(key, state);
        } catch (err) {
          const error = maintenanceError("seed", err);
          this.recordRecoveryFailure(state);
          this.finishAdmission(state, "failed");
          state.failure = { stage: error.stage, code: error.code, phase: "before", turn: state.turns, action: "handover" };
          state.lastError = error.message;
          await this.save(key, state);
          throw error;
        }
      } else if (state.sessionId !== id && state.handover?.phase !== "prepared") {
        // First owner binding is not a replacement; preserve explicitly admitted intent.
        if (state.sessionId !== undefined || !state.admission || state.admission.execution !== "pending") {
          this.finishAdmission(state, "superseded");
          state.pending = undefined;
          state.continuationPreparationRequired = undefined;
        }
        state.handover = undefined;
        state.recoveryRetry = undefined;
        state.pressureSinceCompaction = false;
        state.lastCompact = undefined;
        state.lastHandover = undefined;
        state.assessmentFailures = undefined;
        state.unknownUsageNotified = false;
        state.sessionId = id;
        await this.save(key, state);
      }
    });
    const state = await this.load(key); const policy = this.policy();
    const percent = session.status().contextPercent;
    if (!policy.enabled || state.turns % policy.checkEveryTurns !== 0) return "";
    if (percent === undefined || !Number.isFinite(percent)) return "Context usage is unknown; no percentage was inferred. Assess useful boundaries explicitly with plugin_context_maintenance.";
    if (percent < policy.assessPercent) return "";
    return `Context usage is ${Math.round(percent)}%. Assess whether compaction is useful at this task boundary. If needed request plugin_context_maintenance with what to preserve and how to resume. Continue normally if continuity is more important. ${preserve}`;
  }
  /** Checker prerequisite uses the same durable request, archive and runtime lifecycle.
   * Unlike optional threshold maintenance, failure must hold the working prompt.
   * Disabled automatic policy never becomes permission for an implicit manual request.
   */
  async prepareContinuation(key: string, session: RuntimeSession, rotate: (handover: ContextRecord["handover"]) => Promise<RuntimeSession>, action: "compact" | "handover", preserveText: string, resume: string, target?: Address): Promise<void> {
    const policy = this.policy();
    if (!["compact", "handover"].includes(action) || !policy.enabled || (action === "handover" && !policy.autoHandover)) throw new MaintenanceError("assessment", "failed");
    const existing = await this.status(key);
    if (existing.continuationPreparationRequired && existing.pending) {
      await this.beforeTurn(key, session, rotate, target, resume);
      return;
    }
    await this.serial(this.file(key), async () => {
      const state = await this.load(key);
      if (state.pending || state.handover?.phase === "prepared") throw new MaintenanceError("assessment", "failed");
      if (preserveText.length + resume.length > 16000) throw new MaintenanceError("assessment", "failed");
      state.sessionId = session.status().sessionId;
      state.pending = { action, preserve: preserveText, resume };
      state.continuationPreparationRequired = true;
      state.failure = undefined;
      await this.save(key, state);
    });
    await this.boundary(key, session, rotate, target, action === "compact" ? "after" : "before", resume, false);
    const state = await this.status(key);
    if (state.failure || state.pending || state.handover?.phase === "prepared")
      throw new MaintenanceError(state.failure?.stage ?? "assessment", state.failure?.code ?? "failed");
  }
  async beforeTurn(key: string, session: RuntimeSession, rotate: (handover: ContextRecord["handover"]) => Promise<RuntimeSession>, target?: Address, incomingText = ""): Promise<string | undefined> {
    const state = await this.status(key);
    if (state.continuationPreparationRequired && state.pending) {
      const policy = this.policy();
      if (!policy.enabled || (state.pending.action === "handover" && !policy.autoHandover)) throw new MaintenanceError("assessment", "failed");
      await this.boundary(key, session, rotate, target, state.pending.action === "compact" ? "after" : "before", incomingText, false);
      const prepared = await this.status(key);
      if (prepared.failure || prepared.pending || prepared.handover?.phase === "prepared")
        throw new MaintenanceError(prepared.failure?.stage ?? "assessment", prepared.failure?.code ?? "failed");
      return;
    }
    return this.boundary(key, session, rotate, target, "before", incomingText);
  }
  async boundary(key: string, session: RuntimeSession, rotate: (handover: ContextRecord["handover"]) => Promise<RuntimeSession>, target?: Address, phase: "before" | "after" = "after", incomingText = "", advanceTurn = true): Promise<string | undefined> {
    return this.serial(this.file(key), async () => {
      const policy = this.policy();
      const state = await this.load(key);
      if (!policy.enabled && !state.pending) return;
      if (target) state.noticeTarget = target;
      const id = session.status().sessionId;
      if (state.completionNotice) {
        const notice = state.completionNotice;
        state.completionNotice = undefined;
        this.recordNotice(key, state, notice);
        await this.save(key, state);
        return state.noticeTarget ? undefined : notice;
      }
      // Recover prepared transitions before considering a new maintenance action.
      if (state.handover?.phase === "prepared" && phase === "before") {
        this.checkRecoveryRetry(state);
        try {
        if (id === state.handover.from) {
          if (!session.summarize) throw new Error("Runtime cannot refresh handover");
          const refreshed = await this.prepareArchive(key, session, `${preserve}\nRefresh intervening turns. Previous checkpoint: ${state.handover.text}`, false);
          state.handover.text = refreshed.text;
          state.handover.archiveId = refreshed.archiveId;
          await this.save(key, state);
          session = await maintenanceStep("rotation", () => rotate(state.handover));
        }
        else {
          if (!session.seedHandover) throw new Error("Runtime cannot recover handover");
          await maintenanceStep("seed", () => session.seedHandover!(state.handover!.text));
        }
        state.handover.to = session.status().sessionId;
        if (state.handover.archiveId) await maintenanceStep("archive-link", () => this.archives.link(key, state.handover!.archiveId!, state.handover!.to!));
        state.handover.phase = "switched";
        state.sessionId = state.handover.to;
        this.finishAdmission(state, "applied");
        state.pending = undefined;
        state.continuationPreparationRequired = undefined;
        state.failure = undefined;
        state.lastError = undefined;
        state.recoveryRetry = undefined;
        state.pressureSinceCompaction = false;
        const notice = state.handover.archiveId
          ? "🔄 Neue Sitzung übernommen; Rückschau gespeichert."
          : "🔄 Neue Sitzung übernommen.";
        this.recordNotice(key, state, notice);
        await this.save(key, state);
        return state.noticeTarget ? undefined : notice;
        } catch (err) {
          const error = maintenanceError("summary", err);
          this.recordRecoveryFailure(state);
          this.finishAdmission(state, "failed");
          state.failure = { stage: error.stage, code: error.code, phase, turn: state.turns, action: "handover" };
          state.lastError = error.message;
          await this.save(key, state);
          throw error; // Fail closed before the working prompt.
        }
      }
      if (state.handover?.phase === "prepared") return;
      if (state.sessionId && state.sessionId !== id) {
        this.finishAdmission(state, "superseded");
        state.pending = undefined;
        state.continuationPreparationRequired = undefined;
        state.pressureSinceCompaction = false;
        state.lastCompact = undefined;
        state.lastHandover = undefined;
        state.assessmentFailures = undefined;
        state.unknownUsageNotified = false;
      }
      state.sessionId = id;
      if (phase === "after" && advanceTurn) state.turns++;
      const request = state.pending;
      const usage = session.status().contextPercent;
      const percent = usage !== undefined && Number.isFinite(usage) ? usage : undefined;
      // Independent cooldowns: compaction cannot continually postpone handover.
      const last = phase === "before" ? state.lastHandover : state.lastCompact;
      const due = state.turns - (last ?? -1000) >= policy.cooldownTurns;
      if (state.continuationPreparationRequired && state.failure) this.checkRecoveryRetry(state);
      const retryDue = state.continuationPreparationRequired || !state.failure || state.turns - state.lastMaintenance >= policy.cooldownTurns;
      const matchingRequest = request && retryDue && (phase === "before" ? request.action === "handover" : request.action === "compact");
      const pressure = percent !== undefined && percent >= (phase === "before" ? policy.assessPercent : policy.compactPercent);
      const failedAt = state.assessmentFailures?.[phase];
      const assessmentDue = failedAt === undefined || state.turns - failedAt >= policy.cooldownTurns;
      const eligible = !request && due && assessmentDue && policy.enabled && percent !== undefined &&
        (phase === "before" || policy.compactionOwner !== "agent") &&
        (phase === "before" ? policy.autoHandover && (pressure || state.pressureSinceCompaction === true) : pressure);
      let decision = percent === undefined ? "usage-unknown" : !due ? "cooldown" : !assessmentDue ? "assessment-backoff" : "below-threshold";
      let automatic = false;
      if (eligible) {
        const recent = (session.archiveEntries?.() ?? []).slice(-8).map(e => `${e.role}: ${e.text}`).join("\n").slice(-16000);
        let action: Awaited<ReturnType<BoundaryAssessment>> = "unknown";
        state.assessmentDiagnostic = undefined;
        try { if (this.assess) action = await this.modelStep(key, signal => this.assess!({ signal, phase, incoming: incomingText.slice(0, 8000), recent, percent, pressureSinceCompaction: state.pressureSinceCompaction === true })); }
        catch (err) {
          const error = maintenanceError("assessment", err);
          state.assessmentDiagnostic = { stage: "assessment", code: error.code, phase, turn: state.turns };
        }
        if (action === "unknown" && !state.assessmentDiagnostic) state.assessmentDiagnostic = { stage: "assessment", code: "unknown", phase, turn: state.turns };
        if (action !== "unknown") state.assessmentDiagnostic = undefined;
        state.assessmentFailures ??= {};
        if (action === "unknown") state.assessmentFailures[phase] = state.turns;
        else delete state.assessmentFailures[phase];
        decision = `assessment-${action}`;
        automatic = action === (phase === "before" ? "handover" : "compact");
      }
      state.observation = { phase, usage: percent === undefined ? "unknown" : "known", percent, decision, turn: state.turns };
      if (phase === "before") state.beforeObservation = state.observation;
      let diagnostic: string | undefined;
      if (policy.enabled && percent === undefined && !state.unknownUsageNotified) {
        diagnostic = "ℹ️ Kontextauslastung derzeit unbekannt; automatische Schwellenentscheidung ausgesetzt. Es wurde kein Prozentwert geschätzt.";
        this.recordNotice(key, state, diagnostic);
        state.unknownUsageNotified = true;
      }
      // PI usage becomes temporarily unknown after every compaction. A known
      // response must not re-arm the chat notice; only a new runtime session does.
      if (!matchingRequest && !automatic) { await this.save(key, state); return state.noticeTarget ? undefined : diagnostic; }
      state.lastMaintenance = state.turns;
      if (phase === "before") state.lastHandover = state.turns;
      else state.lastCompact = state.turns;
      await this.save(key, state); // per-action cooldown reserved even on failure
      let notice: string;
      try {
        const instructions = `${preserve}\nPreserve additionally: ${request?.preserve ?? "current task state"}\nResume: ${request?.resume ?? "continue with the next queued operator request"}`;
        const handover = phase === "before";
        if (handover) {
          // Tool-free summary operation: no extra autonomous working turn or code side effects.
          if (!session.summarize) throw new Error("Runtime does not support handover summaries");
          const prepared = await this.prepareArchive(key, session, instructions);
          state.handover = { phase: "prepared", from: id, ...prepared };
          await this.save(key, state);
          const next = await maintenanceStep("rotation", () => rotate(state.handover));
          state.handover.to = next.status().sessionId;
          state.sessionId = next.status().sessionId;
          state.pressureSinceCompaction = false;
          await maintenanceStep("archive-link", () => this.archives.link(key, prepared.archiveId, state.sessionId!));
          state.handover.phase = "switched";
          notice = "🔄 Neue Sitzung übernommen; Rückschau gespeichert.";
        } else {
          await maintenanceStep("compact", () => this.modelStep(key, signal => session.compact(instructions, signal)));
          state.pressureSinceCompaction = true;
          notice = "♻️ Kontext kompaktiert.";
        }
        state.lastError = undefined;
        state.recoveryRetry = undefined;
        state.failure = undefined;
        this.finishAdmission(state, "applied");
        state.pending = undefined;
        state.continuationPreparationRequired = undefined;
      } catch (err) {
        const error = maintenanceError(phase === "before" ? "summary" : "compact", err);
        // A cancelled model operation defers rather than consumes admitted intent.
        if (error.code !== "cancelled") this.finishAdmission(state, "failed");
        state.failure = { stage: error.stage, code: error.code, phase, turn: state.turns, action: phase === "before" ? "handover" : "compact" };
        state.lastError = error.message;
        if (state.continuationPreparationRequired) this.recordRecoveryFailure(state);
        notice = `⚠️ Kontextwartung nicht vollständig abgeschlossen; kein bestätigter Abschluss. Wiederherstellungsstand bleibt erhalten. Stufe: ${error.stage}; Code: ${error.code}.`;
      }
      this.recordNotice(key, state, notice);
      await this.save(key, state);
      return state.noticeTarget ? undefined : notice;
    });
  }
}
