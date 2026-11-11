import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { SessionArchives } from "./session-archive.js";
import { writeFileDurable } from "./durable.js";
import type { Address, RuntimeSession, SendMeta } from "./types.js";
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
export interface MaintenanceDiagnostic {
  /** Correlation only; no exception messages, paths or stacks. */
  fingerprint: string;
  name: "Error" | "TypeError" | "RangeError" | "AbortError" | "unknown";
  causeCode?: MaintenanceCode;
}
export interface MaintenanceHold {
  state: "waiting" | "blocked";
  operationId: string;
  failedAttempts: number;
  notBefore?: number;
  reason: "backoff" | "exhausted" | "uncertain" | "policy";
}
export const MAX_RECOVERY_FAILURES = 7;
export class MaintenanceError extends Error {
  constructor(readonly stage: MaintenanceStage, readonly code: MaintenanceCode, readonly diagnostic?: MaintenanceDiagnostic) { super(`Context maintenance ${stage}: ${code}`); }
}
export function maintenanceError(stage: MaintenanceStage, err: unknown): MaintenanceError {
  if (err instanceof MaintenanceError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const name = err instanceof Error && ["Error", "TypeError", "RangeError", "AbortError"].includes(err.name) ? err.name as MaintenanceDiagnostic["name"] : "unknown";
  const cause = err instanceof Error ? err.cause : undefined;
  const causeCode = (cause as { code?: unknown } | null)?.code;
  return new MaintenanceError(stage, typeof code === "string" && ["ENOSPC", "EACCES", "EPERM", "EIO", "ENOENT"].includes(code) ? code as MaintenanceCode
    : err instanceof Error && (err.name === "AbortError" || err.message === "Compaction cancelled") ? "cancelled" : "failed", {
      name,
      fingerprint: createHash("sha256").update(JSON.stringify([stage, name, typeof code === "string" ? code.slice(0, 64) : "", err instanceof Error ? err.message.slice(0, 2048) : typeof err,
        cause instanceof Error ? cause.message.slice(0, 2048) : ""])).digest("hex"),
      ...(typeof causeCode === "string" && ["ENOSPC", "EACCES", "EPERM", "EIO", "ENOENT"].includes(causeCode) ? { causeCode: causeCode as MaintenanceCode } : {}),
    });
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
  handover?: { phase: "prepared" | "switched"; from: string; to?: string; text: string; archiveId?: string; sourceDigest?: string };
  failure?: { stage: MaintenanceStage; code: MaintenanceCode; phase: "before" | "after"; turn: number; action: "compact" | "handover" };
  /** Recovery cannot use turn cooldown: fail-closed foreground does not advance turns. */
  recoveryRetry?: { attempts: number; notBefore: number };
  recovery?: {
    id: string;
    state: "ready" | "waiting" | "blocked" | "applied" | "cancelled";
    failedAttempts: number;
    /** Explicit admission grants another bounded epoch; lifetime count never resets. */
    epochFailures: number;
    sameErrorFailures: number;
    fingerprint?: string;
    diagnostic?: MaintenanceDiagnostic;
    notBefore?: number;
    reason?: MaintenanceHold["reason"];
    inFlight?: boolean;
    noticeState?: string;
  };
  assessmentDiagnostic?: { stage: "assessment"; code: MaintenanceCode; phase: "before" | "after"; turn: number };
  lastError?: string;
  completionNotice?: string;
  noticeTarget?: Address;
  notices?: { id: string; sessionKey: string; to: Address; text: string; maintenance?: SendMeta["maintenance"] }[];
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
  private recoveryOperation(state: ContextRecord): NonNullable<ContextRecord["recovery"]> {
    if (!state.recovery || ["applied", "cancelled"].includes(state.recovery.state)) {
      const attempts = state.recoveryRetry?.attempts ?? 0;
      const uncertain = attempts > 0 && ["compact", "summary", "rotation", "save"].includes(state.failure?.stage ?? "");
      state.recovery = { id: randomUUID(), state: uncertain || attempts >= MAX_RECOVERY_FAILURES ? "blocked" : attempts ? "waiting" : "ready",
        failedAttempts: attempts, epochFailures: attempts, sameErrorFailures: attempts,
        notBefore: state.recoveryRetry?.notBefore, reason: uncertain ? "uncertain" : attempts >= MAX_RECOVERY_FAILURES ? "exhausted" : "backoff" };
    }
    return state.recovery;
  }
  private recoveryHold(state: ContextRecord): MaintenanceHold | undefined {
    const op = state.recovery;
    if (!op || ["applied", "cancelled"].includes(op.state)) return;
    if (op.state === "blocked" || (op.notBefore !== undefined && this.now() < op.notBefore)) return {
      state: op.state === "blocked" ? "blocked" : "waiting", operationId: op.id, failedAttempts: op.failedAttempts,
      ...(op.state !== "blocked" ? { notBefore: op.notBefore } : {}), reason: op.reason ?? "backoff",
    };
  }
  /** Scheduler fence, not an exception or a retry attempt. Reads never slide the deadline. */
  recoveryStatus(key: string): Promise<MaintenanceHold | undefined> {
    return this.serial(this.file(key), async () => this.recoveryHold(await this.load(key)));
  }
  recoveryReceipt(key: string): Promise<{ operationId: string; state: NonNullable<ContextRecord["recovery"]>["state"] } | undefined> {
    return this.serial(this.file(key), async () => {
      const op = (await this.load(key)).recovery;
      return op ? { operationId: op.id, state: op.state } : undefined;
    });
  }
  private async startRecovery(key: string, state: ContextRecord): Promise<void> {
    const op = this.recoveryOperation(state);
    op.state = "ready";
    op.inFlight = true;
    await this.save(key, state);
  }
  private finishRecovery(state: ContextRecord): void {
    if (state.recovery) { state.recovery.state = "applied"; state.recovery.inFlight = undefined; state.recovery.notBefore = undefined; }
    state.recoveryRetry = undefined;
  }
  private recordRecoveryFailure(key: string, state: ContextRecord, error: MaintenanceError): string | undefined {
    const op = this.recoveryOperation(state);
    op.inFlight = undefined;
    if (error.code !== "cancelled") {
      op.failedAttempts++;
      op.epochFailures++;
      const fingerprint = error.diagnostic?.fingerprint ?? `${error.stage}:${error.code}`;
      op.sameErrorFailures = op.fingerprint === fingerprint ? op.sameErrorFailures + 1 : 1;
      op.fingerprint = fingerprint;
      op.diagnostic = error.diagnostic;
    }
    // Summary also uses native compaction. A rejected call is not proof that
    // nothing was applied. Seed and archive-link, unlike rotation, are idempotent.
    const uncertain = error.code === "cancelled" || !["seed", "archive-link"].includes(error.stage);
    op.state = uncertain || op.epochFailures >= MAX_RECOVERY_FAILURES ? "blocked" : "waiting";
    op.reason = uncertain ? "uncertain" : op.state === "blocked" ? "exhausted" : "backoff";
    op.notBefore = this.now() + Math.min(60000, 1000 * 2 ** Math.min(6, Math.max(0, op.epochFailures - 1)));
    state.recoveryRetry = { attempts: op.failedAttempts, notBefore: op.notBefore };
    const noticeState = `${op.state}:${op.reason}`;
    if (op.noticeState !== noticeState) {
      op.noticeState = noticeState;
      const text = `⚠️ Kontextwartung ${op.state === "blocked" ? "blockiert; explizite Prüfung erforderlich" : "wartet auf Wiederherstellung"}; kein bestätigter Abschluss. Vorgang: ${op.id}; Stufe: ${error.stage}; Code: ${error.code}.`;
      this.recordNotice(key, state, text);
      return state.noticeTarget ? undefined : text;
    }
  }
  private async prepareArchive(key: string, session: RuntimeSession, instructions: string, interruptible = true): Promise<{ text: string; archiveId: string; sourceDigest: string }> {
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
    return { sourceDigest: createHash("sha256").update(JSON.stringify(session.archiveEntries())).digest("hex"), archiveId: archive.id, text: `${forward}\nSource session: ${archive.sourceSessionId}\nArchive ID: ${archive.id}\nRead plugin_session_history section=summary for the retrospective, then search/read entries only as needed. Do this before continuing work. Original tool side effects must not be replayed blindly.` };
  }
  async flushNotices(deliver: (notice: { id: string; sessionKey: string; to: Address; text: string; maintenance?: SendMeta["maintenance"] }) => Promise<void>): Promise<void> {
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
          const notice = state.notices[0];
          await deliver({ ...notice, maintenance: notice.maintenance ?? { state: "notice" } }); // must durably enqueue before acknowledgement
          state.notices.shift();
          await writeFileDurable(file, `${JSON.stringify(state, null, 2)}\n`);
        }
        });
      }
    }
  }
  private recordNotice(key: string, state: ContextRecord, text: string): void {
    if (state.noticeTarget) (state.notices ??= []).push({ id: randomUUID(), sessionKey: key, to: state.noticeTarget, text, maintenance: this.recoveryHold(state) ?? { state: "notice" } });
  }
  private file(key: string): string { return path.join(this.home, "context-maintenance", `${createHash("sha256").update(key).digest("hex")}.json`); }
  private async load(key: string): Promise<ContextRecord> {
    try {
      const state = JSON.parse(await readFile(this.file(key), "utf8"));
      if (state.version !== 1 || !Number.isInteger(state.turns) || !Number.isInteger(state.lastMaintenance)) throw new Error("Invalid context maintenance state");
      if (state.admission && (!/^[a-zA-Z0-9_-]{1,128}$/.test(state.admission.id) ||
          !/^[a-f0-9]{64}$/.test(state.admission.digest) || !Number.isSafeInteger(state.admission.version) || state.admission.version < 1 ||
          !["pending", "applied", "failed", "superseded", "cancelled"].includes(state.admission.execution))) throw Error("Invalid maintenance admission state");
      if (state.recovery && (!/^[a-zA-Z0-9_-]{1,128}$/.test(state.recovery.id) ||
          !["ready", "waiting", "blocked", "applied", "cancelled"].includes(state.recovery.state) ||
          ![state.recovery.failedAttempts, state.recovery.epochFailures, state.recovery.sameErrorFailures].every(n => Number.isSafeInteger(n) && n >= 0) ||
          (state.recovery.notBefore !== undefined && !Number.isFinite(state.recovery.notBefore)))) throw Error("Invalid maintenance recovery state");
      if (state.recoveryRetry && (!Number.isSafeInteger(state.recoveryRetry.attempts) || state.recoveryRetry.attempts < 0 || !Number.isFinite(state.recoveryRetry.notBefore))) throw Error("Invalid maintenance retry state");
      let migrated = false;
      if (!state.recovery && (state.recoveryRetry || state.handover?.phase === "prepared" || state.continuationPreparationRequired && state.failure)) {
        const op = this.recoveryOperation(state);
        if (!state.recoveryRetry && !state.handover?.to) {
          op.state = "blocked";
          op.reason = "uncertain";
        }
        migrated = true;
      }
      if (state.recovery?.inFlight) {
        state.recovery.state = "blocked";
        state.recovery.reason = "uncertain";
        state.recovery.inFlight = undefined;
        state.continuationPreparationRequired = true;
        migrated = true;
      }
      if (migrated) {
        const op = state.recovery!;
        if (op.state === "blocked" && op.noticeState !== `blocked:${op.reason}`) {
          op.noticeState = `blocked:${op.reason}`;
          this.recordNotice(key, state, `⚠️ Kontextwartung blockiert; explizite Prüfung erforderlich. Vorgang: ${op.id}; Code: ${op.reason}.`);
        }
        await this.save(key, state);
      }
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
      const recovering = state.recovery && ["waiting", "blocked"].includes(state.recovery.state);
      if (recovering) {
        // Host admission can reconcile uncertainty by handover, not replay compact.
        if (state.recovery!.reason === "uncertain" && request.action !== "handover") throw Error("Uncertain maintenance requires reconciliation by handover");
        if (state.handover?.phase === "prepared" && (request.action !== "handover" || request.preserve !== state.pending?.preserve || request.resume !== state.pending?.resume)) throw Error("Prepared handover intent must be retained during recovery");
        state.recovery!.state = "ready";
        state.recovery!.epochFailures = 0;
        state.recovery!.sameErrorFailures = 0;
        state.recovery!.notBefore = undefined;
        state.recovery!.noticeState = undefined;
        state.recoveryRetry = undefined;
      } else if (state.pending || state.handover?.phase === "prepared") throw Error("Maintenance already pending");
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
      if (state.recovery && !["applied", "cancelled"].includes(state.recovery.state)) throw Error("Recovery requires versioned maintenance admission");
      if (state.admission && state.pending) throw Error("Identified maintenance already pending");
      state.pending = structuredClone(request);
      state.failure = undefined;
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
      if (state.admission.execution !== "pending" || !state.pending || state.handover?.phase === "prepared" || state.recovery?.reason === "uncertain") throw Error("Maintenance cannot be cancelled at this stage");
      state.pending = undefined;
      state.continuationPreparationRequired = undefined;
      state.failure = undefined;
      state.admission.execution = "cancelled";
      if (state.recovery) state.recovery.state = "cancelled";
      state.recoveryRetry = undefined;
      await this.save(key, state);
    });
  }
  /** Sanitized latest receipt; no preservation text or raw failure data. */
  admissionStatus(key: string): Promise<{ version: number; id?: string; execution?: NonNullable<ContextRecord["admission"]>["execution"]; recovery?: MaintenanceHold }> {
    return this.serial(this.file(key), async () => {
      const state = await this.load(key);
      return { ...(state.admission ? { version: state.admission.version, id: state.admission.id, execution: state.admission.execution } : { version: 0 }),
        ...(this.recoveryHold(state) ? { recovery: this.recoveryHold(state) } : {}) };
    });
  }
  /** A lightweight reminder, not an additional model call. Unknown usage never triggers automatic compaction. */
  async guidance(key: string, session: RuntimeSession): Promise<string> {
    await this.serial(this.file(key), async () => {
      const state = await this.load(key);
      if (this.recoveryHold(state)) return;
      const id = session.status().sessionId;
      if (state.handover?.phase === "prepared" && id !== state.handover.from) {
        await this.startRecovery(key, state);
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
          this.finishRecovery(state);
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
          this.recordRecoveryFailure(key, state, error);
          this.finishAdmission(state, "failed");
          state.failure = { stage: error.stage, code: error.code, phase: "before", turn: state.turns, action: "handover" };
          state.lastError = error.message;
          await this.save(key, state);
          return;
        }
      } else if (state.sessionId !== id && state.handover?.phase !== "prepared" && !state.continuationPreparationRequired) {
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
    const state = await this.status(key); const policy = this.policy();
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
  async prepareContinuation(key: string, session: RuntimeSession, rotate: (handover: ContextRecord["handover"]) => Promise<RuntimeSession>, action: "compact" | "handover", preserveText: string, resume: string, target?: Address, operationId?: string): Promise<void> {
    const policy = this.policy();
    if (!["compact", "handover"].includes(action)) throw new MaintenanceError("assessment", "failed");
    const existing = await this.status(key);
    if (operationId && existing.recovery?.id === operationId && existing.recovery.state === "applied") return;
    if (this.recoveryHold(existing)) return;
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
      state.recovery = { id: operationId ?? randomUUID(), state: "ready", failedAttempts: 0, epochFailures: 0, sameErrorFailures: 0 };
      state.continuationPreparationRequired = true;
      state.failure = undefined;
      if (!policy.enabled || (action === "handover" && !policy.autoHandover)) {
        state.recovery.state = "blocked";
        state.recovery.reason = "policy";
        state.recovery.noticeState = "blocked:policy";
        if (target) state.noticeTarget = target;
        this.recordNotice(key, state, `⚠️ Erforderliche Kontextwartung durch Richtlinie blockiert. Vorgang: ${state.recovery.id}.`);
      }
      await this.save(key, state);
    });
    await this.boundary(key, session, rotate, target, action === "compact" ? "after" : "before", resume, false);
  }
  async beforeTurn(key: string, session: RuntimeSession, rotate: (handover: ContextRecord["handover"]) => Promise<RuntimeSession>, target?: Address, incomingText = ""): Promise<string | undefined> {
    const state = await this.status(key);
    if (this.recoveryHold(state)) return;
    if (state.continuationPreparationRequired && state.pending) {
      const policy = this.policy();
      if (state.admission?.execution !== "pending" && (!policy.enabled || (state.pending.action === "handover" && !policy.autoHandover))) {
        await this.serial(this.file(key), async () => {
          const current = await this.load(key);
          const op = this.recoveryOperation(current);
          op.state = "blocked";
          op.reason = "policy";
          await this.save(key, current);
        });
        return;
      }
      return this.boundary(key, session, rotate, target, state.pending.action === "compact" ? "after" : "before", incomingText, false);
    }
    return this.boundary(key, session, rotate, target, "before", incomingText);
  }
  async boundary(key: string, session: RuntimeSession, rotate: (handover: ContextRecord["handover"]) => Promise<RuntimeSession>, target?: Address, phase: "before" | "after" = "after", incomingText = "", advanceTurn = true): Promise<string | undefined> {
    return this.serial(this.file(key), async () => {
      const policy = this.policy();
      const state = await this.load(key);
      if (this.recoveryHold(state)) return;
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
        await this.startRecovery(key, state);
        try {
        if (id === state.handover.from) {
          const digest = createHash("sha256").update(JSON.stringify(session.archiveEntries?.() ?? [])).digest("hex");
          if (state.handover.sourceDigest !== digest) {
            if (!session.summarize) throw new Error("Runtime cannot refresh handover");
            const refreshed = await this.prepareArchive(key, session, `${preserve}\nRefresh intervening turns. Previous checkpoint: ${state.handover.text}`, false);
            Object.assign(state.handover, refreshed);
            await this.save(key, state);
          }
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
        this.finishRecovery(state);
        state.pressureSinceCompaction = false;
        const notice = state.handover.archiveId
          ? "🔄 Neue Sitzung übernommen; Rückschau gespeichert."
          : "🔄 Neue Sitzung übernommen.";
        this.recordNotice(key, state, notice);
        await this.save(key, state);
        return state.noticeTarget ? undefined : notice;
        } catch (err) {
          const error = maintenanceError("summary", err);
          this.recordRecoveryFailure(key, state, error);
          this.finishAdmission(state, "failed");
          state.failure = { stage: error.stage, code: error.code, phase, turn: state.turns, action: "handover" };
          state.lastError = error.message;
          await this.save(key, state);
          return; // Scheduler consumes structured recoveryStatus.
        }
      }
      if (state.handover?.phase === "prepared") return;
      if (state.sessionId && state.sessionId !== id && !state.continuationPreparationRequired) {
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
      state.pending ??= { action: phase === "before" ? "handover" : "compact", preserve, resume: "continue pending work" };
      await this.startRecovery(key, state); // reserve before uncertain runtime effects
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
        this.finishRecovery(state);
        state.failure = undefined;
        this.finishAdmission(state, "applied");
        state.pending = undefined;
        state.continuationPreparationRequired = undefined;
      } catch (err) {
        const error = maintenanceError(phase === "before" ? "summary" : "compact", err);
        // Optional maintenance can still yield to foreground; this is not a
        // mandatory preparation fence, nor a failed recovery attempt.
        if (error.code === "cancelled" && !state.continuationPreparationRequired && state.handover?.phase !== "prepared") {
          if (state.recovery) { state.recovery.state = "ready"; state.recovery.inFlight = undefined; }
          state.recoveryRetry = undefined;
          state.failure = { stage: error.stage, code: error.code, phase, turn: state.turns, action: phase === "before" ? "handover" : "compact" };
          await this.save(key, state);
          return;
        }
        if (error.code !== "cancelled") this.finishAdmission(state, "failed");
        state.failure = { stage: error.stage, code: error.code, phase, turn: state.turns, action: phase === "before" ? "handover" : "compact" };
        state.lastError = error.message;
        state.continuationPreparationRequired = true;
        state.pending ??= { action: phase === "before" ? "handover" : "compact", preserve, resume: "continue pending work" };
        const diagnostic = this.recordRecoveryFailure(key, state, error);
        await this.save(key, state);
        return diagnostic;
      }
      this.recordNotice(key, state, notice);
      await this.save(key, state);
      return state.noticeTarget ? undefined : notice;
    });
  }
}
