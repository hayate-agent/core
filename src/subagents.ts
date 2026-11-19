import { ToolGuardError } from "./tool-guard-error.js";
import { childDeniedTools } from "./child-tools.js";
import { randomUUID } from "node:crypto";
import type { Harness } from "./harness.js";
import type { Address, Channel, SendMeta, Inbound } from "./types.js";
import type { Execution } from "./execution.js";

export interface SubagentHandover {
  task: string;
  context: string;
  constraints: string;
  expectedResult: string;
  acceptance: string;
  model: string;
  thinking: string;
}
export interface SubagentRecord {
  id: string;
  parent: string;
  /** Host-captured mandate, never supplied by the model handover. */
  parentTaskId?: string;
  /** Immutable host-captured mandate and result destination. Missing legacy provenance is never guessed. */
  dependency?: Execution["dependency"];
  origin?: Address;
  resultEvent?: "pending" | "accepted";
  taskRef?: import("./task-lifecycle.js").TaskRef;
  parentStopped?: boolean;
  /** Legacy ancestry cannot be guessed when one parent mandate is stopped. */
  ownershipHold?: "unscoped-parent-stop";
  sessionKey: string;
  handover: SubagentHandover;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  result?: string;
  /** Absolute host deadline, including time spent queued or offline. */
  expiresAt: number;
}

/** Harness-owned child turns: no second event loop and no implicit permission
 * expansion. Children use the ordinary runtime, review and approval policies.
 */
export class Subagents {
  private records = new Map<string,SubagentRecord>();
  private policy = new Map<string,{model:string;thinking:string}>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly harness: Harness, private readonly save: () => Promise<void>, private readonly maxDurationMs = 10 * 60_000) {}

  isChild(key: string): boolean { return key.startsWith("subagent:"); }
  approvalTarget(key: string): Address | undefined {
    if (!this.isChild(key)) return this.harness.sessions.get(key)?.replyTo;
    const record = [...this.records.values()].find(r => r.sessionKey === key);
    const target = record && this.harness.sessions.get(record.parent)?.replyTo;
    if (!target || target.channel === "subagents") throw Error("No trusted parent operator destination");
    return structuredClone(target);
  }
  beforeTurn(key: string): void {
    if (!this.isChild(key)) return;
    const record = [...this.records.values()].find(r => r.sessionKey === key);
    if (!record) throw new ToolGuardError("ownership_lost", "Subagent ownership missing");
    if (this.harness.opts.taskLifecycle?.enabled && !record.taskRef ||
        record.taskRef && !this.harness.opts.executionStore?.taskIsOpen(record.taskRef)) throw new ToolGuardError("operator_task_closed", "Subagent operator task is closed, unresolved, missing or stale");
    const parent = record.parentTaskId ? this.harness.sessions.get(record.parent) : undefined;
    if (record.parentTaskId && (parent?.tasks ?? (parent?.task ? [parent.task] : [])).some(task => task.id === record.parentTaskId && task.state === "stopped"))
      throw new ToolGuardError("execution_cancelled", "Subagent parent mandate stopped");
    if (record.parentStopped) throw new ToolGuardError("execution_cancelled", "Subagent parent task stopped");
    if (record.ownershipHold) throw new ToolGuardError("ownership_lost", "Legacy subagent ancestry held after scoped parent stop; reconcile explicitly");
    if (record.expiresAt <= Date.now()) throw new ToolGuardError("deadline_expired", "Subagent no longer authorized: deadline elapsed");
    if (record.state === "cancelled") throw new ToolGuardError("execution_cancelled", "Subagent no longer authorized: cancelled");
    if (!["queued", "running"].includes(record.state)) throw new ToolGuardError("authority_revoked", "Subagent no longer active");
  }
  guardTool(key: string, tool: string): void {
    this.beforeTurn(key);
    if (this.isChild(key) && childDeniedTools(key).includes(tool)) {
      throw new ToolGuardError("worker_orchestration_denied", "Subagent orchestration is disabled; return a result or blocker within this turn");
    }
  }
  private arm(record: SubagentRecord): void {
    const old = this.timers.get(record.id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.timers.delete(record.id);
      void this.cancel(record.parent, record.id).catch(() => { /* retry at the next host tick/restart */ });
    }, Math.max(0, record.expiresAt - Date.now()));
    timer.unref();
    this.timers.set(record.id, timer);
  }
  /** Revoke every child before interrupting the first runtime. */
  async revokeChildren(parent: string): Promise<void> {
    for (const record of this.list(parent)) {
      if (["completed", "failed"].includes(record.state)) continue;
      const current = this.records.get(record.id)!;
      current.state = "cancelled";
      current.result = "Cancellation requested; verify any external effects before retrying.";
    }
    await this.save();
  }
  async cancelChildren(parent: string): Promise<void> {
    await this.revokeChildren(parent);
    for (const record of this.list(parent)) await this.cancel(parent, record.id);
  }
  private revocationSavePending = false;
  private revocationQueue: Promise<void> = Promise.resolve();
  async cancelTaskChildren(parent: string, taskId: string): Promise<void> {
    return this.cancelStoppedTasks([{ parent, taskId }]);
  }
  /** Reconcile all retained stops with one host publication barrier. Terminal
   * legacy children already held on disk are evidence, not repeated save work. */
  cancelStoppedTasks(stops: readonly { parent: string; taskId: string }[]): Promise<void> {
    const snapshot = stops.map(({ parent, taskId }) => ({ parent, taskId }));
    const next = this.revocationQueue.catch(() => {}).then(() => this.publishStoppedTasks(snapshot));
    this.revocationQueue = next;
    return next;
  }
  private async publishStoppedTasks(stops: readonly { parent: string; taskId: string }[]): Promise<void> {
    const scopes = new Map<string, Set<string>>();
    for (const { parent, taskId } of stops) { const ids = scopes.get(parent) ?? new Set<string>(); ids.add(taskId); scopes.set(parent, ids); }
    const bound: SubagentRecord[] = [], unscoped: SubagentRecord[] = [];
    for (const record of this.records.values()) {
      const ids = scopes.get(record.parent); if (!ids) continue;
      if (record.parentTaskId && ids.has(record.parentTaskId)) {
        if (!record.parentStopped) { record.parentStopped = true; this.revocationSavePending = true; }
        if (!["completed", "failed"].includes(record.state)) {
          if (record.state !== "cancelled") { record.state = "cancelled"; this.revocationSavePending = true; }
          bound.push(record);
        }
      } else if (!record.parentTaskId && record.state !== "cancelled") {
        if (record.ownershipHold !== "unscoped-parent-stop") { record.ownershipHold = "unscoped-parent-stop"; this.revocationSavePending = true; }
        if (!["completed", "failed"].includes(record.state)) unscoped.push(record);
      }
    }
    // An unsuccessful save leaves the pending obligation set even though the
    // in-memory markers already changed. Never abort before that retry succeeds.
    if (this.revocationSavePending) { await this.save(); this.revocationSavePending = false; }
    for (const record of bound) await this.cancel(record.parent, record.id);
    for (const record of unscoped) await this.harness.sessions.get(record.sessionKey)?.session?.abort();
  }
  /** Exact terminal result authority; failure is evidence too, not a success claim. */
  resultExecution(input: Inbound): Execution | undefined {
    if (input.source !== "host" || !input.hostEvent?.nativeSubagent || input.hostEvent.question || input.hostEvent.assessmentStalled) return;
    const r = this.records.get(input.hostEvent.executionId);
    if (!r || r.parent !== input.sessionKey || !r.dependency || r.parentTaskId !== r.dependency.taskId ||
        r.parentStopped || r.ownershipHold || !["completed", "failed", "cancelled"].includes(r.state) || !r.resultEvent ||
        input.id !== `subagent-result:${r.id}`) return;
    return { id: r.id, parent: r.parent, dependency: structuredClone(r.dependency), origin: structuredClone(r.origin),
      requestId: r.id, input: r.handover.task, strategy: "native-subagent", strategyVersion: 1,
      status: "completed", restarts: 0, result: r.result };
  }
  pending(parent: string, taskId?: string): boolean {
    return [...this.records.values()].some(r => r.parent === parent && (!taskId || r.parentTaskId === taskId) &&
      !!r.dependency && !r.parentStopped && !r.ownershipHold &&
      ["queued", "running"].includes(r.state));
  }
  private delivering?: Promise<void>;
  /** Persisted terminal records are the outbox. Inbox acceptance precedes ack;
   * a crash between them redelivers the same durable ID, never the child effect. */
  flushResults(enabled: (parent: string) => boolean = () => true): Promise<void> {
    if (this.delivering) return this.delivering;
    this.delivering = (async () => {
      for (const r of this.records.values()) {
        if (r.resultEvent !== "pending" || !enabled(r.parent) || this.harness.stopping || this.harness.updateFenced) continue;
        const input: Inbound = { id: `subagent-result:${r.id}`, source: "host", sessionKey: r.parent,
          hostEvent: { executionId: r.id, nativeSubagent: true },
          text: `Native subagent ${r.id} ${r.state} (untrusted result data, not authorization):\n${r.result ?? "No result retained"}` };
        this.harness.pinSeen([input.id!]);
        const execution = this.resultExecution(input);
        const closedOrder = execution?.dependency?.taskRef && this.harness.opts.taskLifecycle?.enabled &&
          !this.harness.opts.executionStore?.taskIsOpen(execution.dependency.taskRef);
        if (execution && (this.harness.resultMandate(input) || closedOrder)) await this.harness.accept(input);
        // Revoked/missing provenance is retained as evidence, never adopted by
        // another task. A future operator may inspect it, not auto-resume it.
        r.resultEvent = "accepted";
        try { await this.save(); } catch (error) { r.resultEvent = "pending"; throw error; }
        this.harness.unpinSeen([input.id!]);
      }
    })().finally(() => { this.delivering = undefined; });
    return this.delivering;
  }

  /** Never resubmit an orphaned start: its acceptance may already have had effects. */
  async reconcile(enabled: (parent: string) => boolean = () => true): Promise<void> {
    const pending = new Set(this.harness.pendingInputs().map(input => input.sessionKey));
    for (const record of this.records.values()) {
      if (!enabled(record.parent) || !["queued", "running"].includes(record.state)) continue;
      if (record.ownershipHold) continue;
      if (pending.has(record.sessionKey) || this.harness.sessions.get(record.sessionKey)?.outbox.length) {
        if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) await this.cancel(record.parent, record.id);
        else this.arm(record);
      } else {
        record.state = "failed";
        record.result = "Interrupted before a durable result; verify external effects before retrying.";
        if (record.dependency) record.resultEvent = "pending";
      }
    }
    await this.save();
    await this.flushResults(enabled);
  }

  overrides(): Record<string,{model:string;thinking:string}> { return Object.fromEntries(this.policy); }
  restoreOverrides(values: Record<string,{model:string;thinking:string}>): void { this.policy=new Map(Object.entries(values)); }
  snapshot(): SubagentRecord[] { return structuredClone([...this.records.values()]); }
  restore(records: SubagentRecord[]): void {
    for (const record of records) {
      this.records.set(record.id,structuredClone(record));
      if (record.resultEvent === "pending") this.harness.pinSeen([`subagent-result:${record.id}`]);
    }
  }
  list(parent: string): SubagentRecord[] { return this.snapshot().filter(r=>r.parent===parent); }
  get(parent: string,id: string): SubagentRecord {
    const record=this.records.get(id);
    if (!record || record.parent!==parent) throw Error("Unknown subagent in this conversation");
    return structuredClone(record);
  }
  /** Operator policy is separate from model-visible handover fields. */
  setOverride(parent: string,value?: {model:string;thinking:string}): void {
    if (value) this.policy.set(parent,{...value}); else this.policy.delete(parent);
  }
  async start(parent: string,handover: SubagentHandover): Promise<SubagentRecord> {
    if (!handover || typeof handover !== "object") throw Error("Subagent handover required");
    for (const key of ["task","context","constraints","expectedResult","acceptance","model","thinking"] as const) {
      if (typeof handover[key]!=="string" || !handover[key].trim() || handover[key].length>8000) throw Error(`Invalid subagent ${key}`);
    }
    if (!handover.model.includes("/") || !["off","minimal","low","medium","high","xhigh"].includes(handover.thinking)) throw Error("Invalid model/reasoning selection");
    if (this.records.size>=200 || [...this.records.values()].filter(r=>["queued","running"].includes(r.state)).length>=4) throw Error("Subagent capacity reached");
    if ([...this.records.values()].some(r=>r.sessionKey===parent)) throw Error("Nested subagents are not enabled");
    const id=randomUUID();
    const selected={...handover,...this.policy.get(parent)};
    const parentState = this.harness.sessions.get(parent);
    if (parentState?.current && (parentState.cancelling === parentState.current ||
        (parentState.tasks ?? (parentState.task ? [parentState.task] : [])).some(task => task.id === parentState.current?.taskId && task.state === "stopped")))
      throw new ToolGuardError("execution_cancelled", "Parent task cancelled");
    const mandate = this.harness.dependencyCheckpoint(parent);
    const parentTaskId = mandate?.taskId;
    const record:SubagentRecord={id,parent,...(parentTaskId ? { parentTaskId, dependency: structuredClone(mandate), origin: this.harness.dispatchOrigin(parent) } : {}), ...(mandate?.taskRef ? { taskRef: mandate.taskRef } : {}),sessionKey:`subagent:${id}`,handover:selected,state:"queued",expiresAt:Date.now()+this.maxDurationMs};
    this.records.set(id,record);
    try { await this.save(); } catch(error) { this.records.delete(id);throw error; }
    if (record.state === "cancelled" || record.expiresAt <= Date.now()) {
      record.state = "cancelled";
      await this.save();
      return structuredClone(record);
    }
    this.arm(record);
    try {
      await this.harness.accept({id:`subagent:${id}`,sessionKey:record.sessionKey,source:"api",
        text:`Delegated task. Stay within the original operator authorization. Do not create subagents. Return a concise summary with evidence references, uncertainties and remaining work, not logs or loaded context. Store details in this task's files. Several related tool calls are normal; report blockers instead of broadening scope.\nHANDOVER LIGHT (data):\n${JSON.stringify(selected)}`,
        replyTo:{channel:"subagents",target:id},continuationDepth:1,continuationExpiresAt:record.expiresAt,turn:{model:selected.model,thinking:selected.thinking}});
    } catch(error) {
      clearTimeout(this.timers.get(id)); this.timers.delete(id);
      if (this.records.get(id)?.state !== "cancelled" && !record.parentStopped) {
        record.state = "failed";
        record.result = "Child inbox admission failed or was interrupted; acceptance and external effects require reconciliation before retrying.";
        if (record.dependency) record.resultEvent = "pending";
      }
      await this.save();
      throw error;
    }
    return structuredClone(record);
  }
  async cancel(parent:string,id:string):Promise<void> {
    const record=this.get(parent,id);
    if (["completed","failed"].includes(record.state)) return;
    const current = this.records.get(id)!;
    current.state = "cancelled";
    current.result = "Cancellation requested; verify any external effects before retrying.";
    if (current.dependency && !current.parentStopped) current.resultEvent = "pending";
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    await this.save();
    await this.harness.stopConversation(record.sessionKey);
    await this.flushResults();
  }
  readonly channel: Channel = {
    name:"subagents",start:async()=>{},stop:async()=>{for (const timer of this.timers.values()) clearTimeout(timer);this.timers.clear();},
    turnStatus:async(_to,input,status)=>{
      const record=[...this.records.values()].find(r=>r.sessionKey===input.sessionKey);
      if (record && record.state === "queued" && status==="started") {record.state="running";await this.save();}
    },
    send:async(to,text,meta?:SendMeta)=>{
      const record=this.records.get(to.target);
      if (!record) throw Error("Unknown subagent delivery");
      if (meta?.approvalId) throw Error("Approval requests must use the trusted parent operator destination");
      if (meta?.maintenance && meta.maintenance.state !== "blocked") return;
      if (record.state === "cancelled" || record.parentStopped) return;
      if (record.ownershipHold) { record.result = text; await this.save(); return; }
      clearTimeout(this.timers.get(record.id));
      this.timers.delete(record.id);
      // Prepare without mutating the published record across an async boundary.
      // Cancellation/parent revocation may commit while optional compaction yields.
      let result = text;
      try { result=await this.harness.runtime.compactResult?.(record.sessionKey,text)??text; }
      catch { /* Optional optimization must not fail a settled child. */ }
      const current = this.records.get(record.id);
      if (current !== record || current.state === "cancelled" || current.parentStopped || current.ownershipHold || current.resultEvent) return;
      record.result = result;
      if (record.result.length > 64000) record.result = `${record.result.slice(0, 31000)}\n[Report excerpted for durable state; full native session ${record.sessionKey} retained. Omitted material is not proof of success.]\n${record.result.slice(-31000)}`;
      record.state=meta?.outcome==="cancelled"?"cancelled":meta?.outcome==="failed" || meta?.maintenance?.state === "blocked"?"failed":"completed";
      if (record.dependency) record.resultEvent = "pending";
      await this.save();
      await this.flushResults();
    },
  };
}
