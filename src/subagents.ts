import { randomUUID } from "node:crypto";
import type { Harness } from "./harness.js";
import type { Address, Channel, SendMeta } from "./types.js";

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
    if (!record || !["queued", "running"].includes(record.state) || record.expiresAt <= Date.now()) {
      throw Error("Subagent no longer authorized to execute");
    }
  }
  guardTool(key: string, tool: string): void {
    this.beforeTurn(key);
    if (this.isChild(key) && ["plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"].includes(tool)) {
      throw Error("Subagent orchestration is disabled; return a result or blocker within this turn");
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
  async cancelChildren(parent: string): Promise<void> {
    for (const record of this.list(parent)) await this.cancel(parent, record.id);
  }
  /** Never resubmit an orphaned start: its acceptance may already have had effects. */
  async reconcile(): Promise<void> {
    const pending = new Set(this.harness.pendingInputs().map(input => input.sessionKey));
    for (const record of this.records.values()) {
      if (!["queued", "running"].includes(record.state)) continue;
      if (pending.has(record.sessionKey) || this.harness.sessions.get(record.sessionKey)?.outbox.length) {
        if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) await this.cancel(record.parent, record.id);
        else this.arm(record);
      } else {
        record.state = "failed";
        record.result = "Interrupted before a durable result; verify external effects before retrying.";
      }
    }
    await this.save();
  }

  overrides(): Record<string,{model:string;thinking:string}> { return Object.fromEntries(this.policy); }
  restoreOverrides(values: Record<string,{model:string;thinking:string}>): void { this.policy=new Map(Object.entries(values)); }
  snapshot(): SubagentRecord[] { return structuredClone([...this.records.values()]); }
  restore(records: SubagentRecord[]): void {
    for (const record of records) this.records.set(record.id,structuredClone(record));
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
    const record:SubagentRecord={id,parent,sessionKey:`subagent:${id}`,handover:selected,state:"queued",expiresAt:Date.now()+this.maxDurationMs};
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
        text:`Delegated task. Stay within the original operator authorization. Do not create subagents. Return the requested result and evidence; report blockers instead of broadening scope.\nHANDOVER LIGHT (data):\n${JSON.stringify(selected)}`,
        replyTo:{channel:"subagents",target:id},continuationDepth:1,continuationExpiresAt:record.expiresAt,turn:{model:selected.model,thinking:selected.thinking}});
    } catch(error) {clearTimeout(this.timers.get(id));this.timers.delete(id);record.state="failed";await this.save();throw error;}
    return structuredClone(record);
  }
  async cancel(parent:string,id:string):Promise<void> {
    const record=this.get(parent,id);
    if (["completed","failed","cancelled"].includes(record.state)) return;
    await this.harness.stopConversation(record.sessionKey);
    const current = this.records.get(id)!;
    current.state = "cancelled";
    current.result = "Cancellation requested; verify any external effects before retrying.";
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    await this.save();
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
      if (record.state === "cancelled") return;
      clearTimeout(this.timers.get(record.id));
      this.timers.delete(record.id);
      record.result=text.slice(0,64000);
      record.state=meta?.outcome==="cancelled"?"cancelled":meta?.outcome==="failed"?"failed":"completed";
      await this.save();
    },
  };
}
