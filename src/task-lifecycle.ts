import { createHash, randomUUID } from "node:crypto";

/** Core authority, independent of conversation history and execution strategy. */
export interface TaskRef { id: string; generation: number }
export type TodoKind = "memory-research" | "skill-research" | "source-research" | "internet-research" | "work" | "verification" | "skill-check" | "skill-change" | "delivery";
export interface TaskTodo {
  id: string; title: string; kind: TodoKind;
  status: "open" | "running" | "waiting" | "done" | "omitted";
  sourceId: string; outcome?: string;
}
export interface TaskReceipt {
  id: string; kind: "created" | "legacy-held" | "operator-close" | "operator-reopen" | "clarification" | "outcome" | "inactivity";
  at: number; sourceId: string; generation: number; revision: number; digest: string; reason?: string;
}
export interface CoreTask {
  id: string; generation: number; revision: number;
  operatorStatus: "open" | "done" | "unresolved";
  original: string;
  sources: Array<{ id: string; text: string; at: number; kind: "operator" | "schedule" }>;
  lastOperatorAt: number; createdAt: number;
  /** Explicit schedules never expire just because nobody mentions them in chat. */
  scheduled: boolean;
  technical: { state: "unknown" | "open" | "running" | "waiting" | "blocked" | "completed" | "failed"; evidence?: string };
  plan?: TaskTodo[];
  receipts: TaskReceipt[];
  receiptArchive?: { head: string; count: number };
}
export interface TaskBinding { sessionKey: string; taskId: string; ref: TaskRef }
export interface TaskBook { tasks: CoreTask[]; bindings: TaskBinding[] }
export interface TaskOutcome {
  ref: TaskRef; expectedRevision: number; eventId: string;
  technical: CoreTask["technical"];
  /** Proposals are committed only with a settled turn; authority remains host-owned. */
  plan?: TaskTodo[];
}
const kinds: TodoKind[] = ["memory-research", "skill-research", "source-research", "internet-research", "work", "verification", "skill-check", "skill-change", "delivery"];
const nonempty = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
export const taskDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function validTaskRef(value: unknown): value is TaskRef {
  const r = value as TaskRef;
  return !!r && nonempty(r.id, 160) && Number.isSafeInteger(r.generation) && r.generation > 0;
}
export function validateTaskBook(book: TaskBook): void {
  if (!book || !Array.isArray(book.tasks) || !Array.isArray(book.bindings) || book.tasks.length > 2000 || book.bindings.length > 10000) throw Error("Invalid task book");
  const ids = new Set<string>();
  for (const t of book.tasks) {
    if (!validTaskRef(t) || ids.has(t.id) || !Number.isSafeInteger(t.revision) || t.revision < 1 ||
        !["open", "done", "unresolved"].includes(t.operatorStatus) || !nonempty(t.original, 100000) ||
        !Number.isSafeInteger(t.createdAt) || !Number.isSafeInteger(t.lastOperatorAt) || typeof t.scheduled !== "boolean" ||
        !Array.isArray(t.sources) || !t.sources.length || t.sources.length > 64 ||
        t.sources.some(s => !nonempty(s.id, 256) || !nonempty(s.text, 100000) || !Number.isSafeInteger(s.at) || !["operator", "schedule"].includes(s.kind)) ||
        !t.technical || !["unknown", "open", "running", "waiting", "blocked", "completed", "failed"].includes(t.technical.state) ||
        t.technical.evidence !== undefined && !nonempty(t.technical.evidence, 8000) ||
        !Array.isArray(t.receipts) || !t.receipts.length || t.receipts.length > 512 ||
        new Set(t.receipts.map(r => r.id)).size !== t.receipts.length ||
        t.receipts.some(r => !nonempty(r.id, 256) || !nonempty(r.sourceId, 256) || !Number.isSafeInteger(r.at) ||
          !Number.isSafeInteger(r.generation) || r.generation < 1 || r.generation > t.generation ||
          !Number.isSafeInteger(r.revision) || r.revision < 1 || r.revision > t.revision || !/^[a-f0-9]{64}$/.test(r.digest) || r.reason !== undefined && !nonempty(r.reason, 8000) ||
          !["created", "legacy-held", "operator-close", "operator-reopen", "clarification", "outcome", "inactivity"].includes(r.kind))) throw Error("Invalid core task");
    if (t.receiptArchive && (!/^[a-f0-9]{64}$/.test(t.receiptArchive.head) || !Number.isSafeInteger(t.receiptArchive.count) || t.receiptArchive.count < 1)) throw Error("Invalid task receipt archive");
    ids.add(t.id); if (t.plan) validatePlan(t, t.plan);
  }
  const bindings = new Set<string>();
  for (const b of book.bindings) {
    const key = JSON.stringify([b.sessionKey, b.taskId]);
    if (!nonempty(b.sessionKey, 512) || !nonempty(b.taskId, 256) || !validTaskRef(b.ref) ||
        !book.tasks.some(t => t.id === b.ref.id && t.generation >= b.ref.generation) || bindings.has(key)) throw Error("Invalid task binding");
    bindings.add(key);
  }
}
export function validatePlan(task: CoreTask, plan: TaskTodo[]): void {
  if (!Array.isArray(plan) || !plan.length || plan.length > 48 || new Set(plan.map(t => t.id)).size !== plan.length ||
      plan.some(t => !nonempty(t.id, 100) || !nonempty(t.title, 500) || !kinds.includes(t.kind) ||
        !["open", "running", "waiting", "done", "omitted"].includes(t.status) || !task.sources.some(s => s.id === t.sourceId) ||
        t.outcome !== undefined && !nonempty(t.outcome, 2000) || ["done", "omitted"].includes(t.status) && !t.outcome)) throw Error("Invalid task plan or missing outcome/source");
  for (const kind of ["memory-research", "skill-research", "source-research", "internet-research", "skill-check"])
    if (!plan.some(t => t.kind === kind)) throw Error(`Planned task requires ${kind}; explain an omission with an outcome`);
}
export function taskFor(book: TaskBook, ref: TaskRef): CoreTask {
  const task = book.tasks.find(t => t.id === ref.id);
  if (!task || task.generation !== ref.generation) throw Error("Task generation is stale or missing");
  return task;
}
export function taskOpen(book: TaskBook, ref: TaskRef): boolean {
  return book.tasks.some(t => t.id === ref.id && t.generation === ref.generation && t.operatorStatus === "open");
}
function receipt(task: CoreTask, id: string, kind: TaskReceipt["kind"], sourceId: string, at: number, digest: string, reason?: string): void {
  if (task.receipts.length >= 512) throw Error("Task receipt limit reached; explicit archival required");
  task.receipts.push({ id, kind, sourceId, at, digest, generation: task.generation, revision: task.revision, ...(reason ? { reason } : {}) });
}
export function enrollTask(book: TaskBook, binding: Omit<TaskBinding, "ref">, original: string, sourceId: string,
  kind: "operator" | "schedule" | "legacy", now: number): TaskRef {
  const old = book.bindings.find(b => b.sessionKey === binding.sessionKey && b.taskId === binding.taskId);
  if (old) {
    if (book.tasks.find(t => t.id === old.ref.id)?.original !== original) throw Error("Task original scope conflict");
    return old.ref;
  }
  if (!nonempty(original, 100000) || !nonempty(sourceId, 256)) throw Error("Invalid task ingress");
  const task: CoreTask = { id: randomUUID(), generation: 1, revision: 1, operatorStatus: kind === "legacy" ? "unresolved" : "open",
    original, sources: [{ id: sourceId, text: original, at: now, kind: kind === "schedule" ? "schedule" : "operator" }],
    lastOperatorAt: now, createdAt: now, scheduled: kind === "schedule", technical: { state: "unknown" }, receipts: [] };
  receipt(task, `create:${sourceId}`, kind === "legacy" ? "legacy-held" : "created", sourceId, now, taskDigest([original, kind, binding]));
  const ref = { id: task.id, generation: 1 }; book.tasks.push(task); book.bindings.push({ ...binding, ref }); return ref;
}
export function operatorTransition(book: TaskBook, ref: TaskRef, expected: number, eventId: string,
  action: "close" | "reopen" | "clarify", text: string, now: number): TaskRef {
  const task = book.tasks.find(t => t.id === ref.id);
  if (!task || !nonempty(eventId, 256) || !nonempty(text, 8000)) throw Error("Task and authentic operator source required");
  const digest = taskDigest([ref.id, action, text]); // stable across a successful command's revision/generation change
  const old = task.receipts.find(r => r.id === eventId);
  if (old) { if (old.digest !== digest) throw Error("Operator receipt identity conflict"); return { id: task.id, generation: old.generation }; }
  taskFor(book, ref); if (task.revision !== expected) throw Error("Task revision changed; inspect before deciding");
  if (action === "clarify" && task.operatorStatus !== "open") throw Error("Explicit reopen required");
  if (action === "reopen") { task.generation++; task.operatorStatus = "open"; }
  else if (action === "close") task.operatorStatus = "done";
  if (action !== "close") {
    if (task.sources.length >= 64) throw Error("Task source limit reached");
    task.sources.push({ id: eventId, text, at: now, kind: "operator" });
  }
  if (action !== "close") task.technical = { state: "open", ...(task.technical.evidence ? { evidence: `Historical outcome before this operator change:\n${task.technical.evidence}`.slice(0, 8000) } : {}) };
  task.revision++; task.lastOperatorAt = now;
  receipt(task, eventId, action === "close" ? "operator-close" : action === "reopen" ? "operator-reopen" : "clarification", eventId, now, digest, text);
  return { id: task.id, generation: task.generation };
}
export function commitTaskOutcome(book: TaskBook, update: TaskOutcome, now: number): void {
  const task = book.tasks.find(t => t.id === update.ref.id); if (!task) throw Error("Unknown outcome task");
  const digest = taskDigest(update); const old = task.receipts.find(r => r.id === update.eventId);
  if (old) { if (old.digest !== digest) throw Error("Outcome identity conflict"); return; }
  // Late outcomes remain in the execution/turn ledger, but cannot alter a closed
  // task or a later generation's plan, technical state or operator disposition.
  if (!taskOpen(book, update.ref)) return;
  if (task.revision !== update.expectedRevision) return; // retain turn evidence, never overwrite concurrent operator steering
  if (update.plan) {
    validatePlan(task, update.plan);
    for (const prior of task.plan ?? []) {
      const next = update.plan.find(t => t.id === prior.id);
      if (!next || next.kind !== prior.kind || next.sourceId !== prior.sourceId ||
          ["done", "omitted"].includes(prior.status) && JSON.stringify(next) !== JSON.stringify(prior)) throw Error("Outcome cannot remove or reopen settled todos");
    }
    task.plan = structuredClone(update.plan);
  }
  task.technical = structuredClone(update.technical);
  if (task.technical.state === "completed" && task.plan?.some(t => !["done", "omitted"].includes(t.status))) task.technical.state = "open";
  task.revision++;
  receipt(task, update.eventId, "outcome", update.eventId, now, digest);
}
export function expireInactiveTasks(book: TaskBook, now: number, inactivityMs: number): string[] {
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs < 60000) throw Error("Explicit inactivity interval required");
  const closed: string[] = [];
  for (const task of book.tasks) if (task.operatorStatus === "open" && !task.scheduled && now - task.lastOperatorAt >= inactivityMs) {
    task.operatorStatus = "done"; task.revision++;
    receipt(task, `idle:${task.generation}:${task.lastOperatorAt}`, "inactivity", "host-inactivity-policy", now, taskDigest([inactivityMs, task.lastOperatorAt])); closed.push(task.id);
  }
  return closed;
}
export function renderTask(task: CoreTask): string {
  const state = task.operatorStatus === "done" ? "Auftrag erledigt" : task.operatorStatus === "unresolved" ? "Altauftrag: Operatorentscheidung erforderlich" : "Auftrag offen";
  const lines = [`${state} · ${task.id} · Generation ${task.generation}, Revision ${task.revision}`, task.original.slice(0, 800)];
  if (task.plan) for (const todo of task.plan) lines.push(`${({ open: "[ ]", running: "[>]", waiting: "[~]", done: "[x]", omitted: "[-]" } as const)[todo.status]} ${todo.id}: ${todo.title}${todo.status === "omitted" ? ` — ${todo.outcome}` : ""}`);
  lines.push(`Technischer Stand (unabhängig): ${task.technical.state}`); return lines.join("\n");
}
