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
  id: string; kind: "created" | "legacy-held" | "operator-close" | "operator-reopen" | "clarification" | "outcome" | "inactivity" | "scheduled-silence" | "evidence-close";
  at: number; sourceId: string; generation: number; revision: number; digest: string; reason?: string;
}
export interface CoreTask {
  id: string; generation: number; revision: number;
  operatorStatus: "open" | "done" | "unresolved";
  original: string;
  /** `seq`: book-wide monotonic ingress order (clock-independent); absent on legacy sources. */
  sources: Array<{ id: string; text: string; at: number; kind: "operator" | "schedule"; seq?: number }>;
  lastOperatorAt: number; createdAt: number;
  /** Explicit schedules never expire just because nobody mentions them in chat. */
  scheduled: boolean;
  technical: { state: "unknown" | "open" | "running" | "waiting" | "blocked" | "completed" | "failed"; evidence?: string };
  plan?: TaskTodo[];
  receipts: TaskReceipt[];
  receiptArchive?: { head: string; count: number };
}
export interface TaskBinding { sessionKey: string; taskId: string; ref: TaskRef }
export interface TaskBook { tasks: CoreTask[]; bindings: TaskBinding[]; /** Last issued source seq. */ sourceSeq?: number }
/** A durable acceptance-time reservation keeps ingress order even when enrollment is delayed
 * (handoff, restart); otherwise the next sequence is issued now. */
function nextSourceSeq(book: TaskBook, reserved?: number): number {
  if (reserved !== undefined && Number.isSafeInteger(reserved) && reserved >= 1) {
    book.sourceSeq = Math.max(book.sourceSeq ?? 0, reserved); return reserved;
  }
  const legacyMax = Math.max(0, ...book.tasks.flatMap(t => t.sources.map(s => s.seq ?? 0)));
  book.sourceSeq = Math.max(book.sourceSeq ?? 0, legacyMax) + 1;
  return book.sourceSeq;
}
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
  if (!book || !Array.isArray(book.tasks) || !Array.isArray(book.bindings)) throw Error("Invalid task book");
  const ids = new Set<string>();
  for (const t of book.tasks) {
    if (!validTaskRef(t) || ids.has(t.id) || !Number.isSafeInteger(t.revision) || t.revision < 1 ||
        !["open", "done", "unresolved"].includes(t.operatorStatus) || !nonempty(t.original, 16 * 1024 * 1024) ||
        !Number.isSafeInteger(t.createdAt) || !Number.isSafeInteger(t.lastOperatorAt) || typeof t.scheduled !== "boolean" ||
        !Array.isArray(t.sources) || !t.sources.length || t.sources.length > 64 ||
        t.sources.some(s => !nonempty(s.id, 256) || !nonempty(s.text, 16 * 1024 * 1024) || !Number.isSafeInteger(s.at) || !["operator", "schedule"].includes(s.kind) ||
          s.seq !== undefined && (!Number.isSafeInteger(s.seq) || s.seq < 1)) ||
        !t.technical || !["unknown", "open", "running", "waiting", "blocked", "completed", "failed"].includes(t.technical.state) ||
        t.technical.evidence !== undefined && !nonempty(t.technical.evidence, 8000) ||
        !Array.isArray(t.receipts) || !t.receipts.length || t.receipts.length > 512 ||
        new Set(t.receipts.map(r => r.id)).size !== t.receipts.length ||
        t.receipts.some(r => !nonempty(r.id, 256) || !nonempty(r.sourceId, 256) || !Number.isSafeInteger(r.at) ||
          !Number.isSafeInteger(r.generation) || r.generation < 1 || r.generation > t.generation ||
          !Number.isSafeInteger(r.revision) || r.revision < 1 || r.revision > t.revision || !/^[a-f0-9]{64}$/.test(r.digest) || r.reason !== undefined && !nonempty(r.reason, 8000) ||
          !["created", "legacy-held", "operator-close", "operator-reopen", "clarification", "outcome", "inactivity", "scheduled-silence", "evidence-close"].includes(r.kind))) throw Error("Invalid core task");
    if (t.receiptArchive && (!/^[a-f0-9]{64}$/.test(t.receiptArchive.head) || !Number.isSafeInteger(t.receiptArchive.count) || t.receiptArchive.count < 1)) throw Error("Invalid task receipt archive");
    ids.add(t.id); if (t.plan) validatePlan(t, t.plan);
  }
  const byId = new Map(book.tasks.map(task => [task.id, task]));
  const bindings = new Set<string>();
  for (const b of book.bindings) {
    const key = JSON.stringify([b.sessionKey, b.taskId]);
    if (!nonempty(b.sessionKey, 512) || !nonempty(b.taskId, 256) || !validTaskRef(b.ref) ||
        (!byId.has(b.ref.id) || byId.get(b.ref.id)!.generation < b.ref.generation) || bindings.has(key)) throw Error("Invalid task binding");
    bindings.add(key);
  }
}
export function validatePlan(task: CoreTask, plan: TaskTodo[]): void {
  if (!Array.isArray(plan) || !plan.length || plan.length > 48 || new Set(plan.map(t => t.id)).size !== plan.length ||
      plan.some(t => !nonempty(t.id, 100) || !nonempty(t.title, 500) || !kinds.includes(t.kind) ||
        !["open", "running", "waiting", "done", "omitted"].includes(t.status) || !task.sources.some(s => s.id === t.sourceId) ||
        t.outcome !== undefined && !nonempty(t.outcome, 2000) || ["done", "omitted"].includes(t.status) && !t.outcome)) throw Error("Invalid task plan or missing outcome/source");
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
/** Highest issued source sequence of the book (including legacy-recorded sources). */
export function sourceSeqOf(book: TaskBook | undefined): number {
  return book ? Math.max(book.sourceSeq ?? 0, 0, ...book.tasks.flatMap(t => t.sources.map(s => s.seq ?? 0))) : 0;
}
export function enrollTask(book: TaskBook, binding: Omit<TaskBinding, "ref">, original: string, sourceId: string,
  kind: "operator" | "schedule" | "legacy", now: number, reservedSeq?: number): TaskRef {
  const old = book.bindings.find(b => b.sessionKey === binding.sessionKey && b.taskId === binding.taskId);
  if (old) {
    if (book.tasks.find(t => t.id === old.ref.id)?.original !== original) throw Error("Task original scope conflict");
    return old.ref;
  }
  if (!nonempty(original, 16 * 1024 * 1024) || !nonempty(sourceId, 256)) throw Error("Invalid task ingress");
  const task: CoreTask = { id: randomUUID(), generation: 1, revision: 1, operatorStatus: kind === "legacy" ? "unresolved" : "open",
    original, sources: [{ id: sourceId, text: original, at: now, kind: kind === "schedule" ? "schedule" : "operator", seq: nextSourceSeq(book, kind === "schedule" ? undefined : reservedSeq) }],
    lastOperatorAt: now, createdAt: now, scheduled: kind === "schedule", technical: { state: "unknown" }, receipts: [] };
  receipt(task, `create:${sourceId}`, kind === "legacy" ? "legacy-held" : "created", sourceId, now, taskDigest([original, kind, binding]));
  const ref = { id: task.id, generation: 1 }; book.tasks.push(task); book.bindings.push({ ...binding, ref }); return ref;
}
export function operatorTransition(book: TaskBook, ref: TaskRef, expected: number, eventId: string,
  action: "close" | "reopen" | "clarify", text: string, now: number, reservedSeq?: number): TaskRef {
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
    // The ingress reservation of the operator input that carries the transition, so a delayed
    // clarification or reopen keeps its arrival position against later messages.
    task.sources.push({ id: eventId, text, at: now, kind: "operator", seq: nextSourceSeq(book, reservedSeq) });
  }
  if (action !== "close") task.technical = { state: "open", ...(task.technical.evidence ? { evidence: `Historical outcome before this operator change:\n${task.technical.evidence}`.slice(0, 8000) } : {}) };
  task.revision++; task.lastOperatorAt = now;
  receipt(task, eventId, action === "close" ? "operator-close" : action === "reopen" ? "operator-reopen" : "clarification", eventId, now, digest, text);
  return { id: task.id, generation: task.generation };
}
/** Operator-delegated self-closure (operator decision 2026-11-23): only an independently
 * assessed, evidenced completion of an open, non-scheduled order. Distinct receipt kind so
 * inspection shows who closed it; operator reopen remains available. */
export function evidenceClose(book: TaskBook, ref: TaskRef, expected: number, eventId: string, evidence: string, now: number): boolean {
  const task = book.tasks.find(t => t.id === ref.id);
  if (!task || !nonempty(eventId, 256) || !nonempty(evidence, 8000)) throw Error("Task and evidence required");
  if (task.receipts.some(r => r.id === eventId)) return false;
  if (!taskOpen(book, ref) || task.scheduled || task.revision !== expected) return false;
  task.operatorStatus = "done";
  task.technical = { state: "completed", evidence };
  task.revision++;
  receipt(task, eventId, "evidence-close", eventId, now, taskDigest([ref.id, "evidence-close", evidence]), evidence);
  return true;
}
/** Authentic operator input of the same conversation received after this order's last
 * operator activity. Evidence that may complete, narrow or supersede it — never new scope. */
/** Bounded projection for assessment evidence. Anything not shown in full is marked
 * `truncated` (text cut or older messages omitted: first item carries the omission), and
 * self-closure fails closed on any truncation. */
/** Every later operator message of the conversation, verbatim, as completion evidence. Bounded
 * (count, per-message and total size); anything cut or omitted is marked `truncated`, which keeps
 * the order fail-closed. The total stays within the smallest assessor prompt budget (typesafe 24 KB;
 * previously up to 6 × 1000 chars) while covering a busy conversation without cuts. */
export function laterOperatorInput(book: TaskBook, sessionKey: string, ref: TaskRef, limit = 64, maxChars = 2000, maxTotal = 8000): Array<{ at: number; text: string; truncated?: true }> {
  const order = book.tasks.find(t => t.id === ref.id);
  if (!order) return [];
  const siblings = new Set(book.bindings.filter(b => b.sessionKey === sessionKey && b.ref.id !== ref.id).map(b => b.ref.id));
  // "Later" by the clock-independent ingress sequence: a sibling operator source issued after
  // this order's newest operator source. Legacy sources without seq fall back to time (>=).
  const ownSeq = Math.max(0, ...order.sources.filter(s => s.kind === "operator").map(s => s.seq ?? 0));
  // Conservative for mixed legacy data: a sequenced sibling source issued after an unsequenced
  // (pre-upgrade) order is always later; two unsequenced sources compare by time (>=).
  const later = (s: CoreTask["sources"][number]) => s.seq !== undefined ? s.seq >= ownSeq : ownSeq === 0 && s.at >= order.lastOperatorAt;
  const all = book.tasks.filter(t => siblings.has(t.id) && !t.scheduled)
    .flatMap(t => t.sources.filter(s => s.kind === "operator" && later(s)))
    .map((s, index) => ({ s, index })).sort((a, b) => (a.s.seq ?? 0) - (b.s.seq ?? 0) || a.s.at - b.s.at || a.index - b.index).map(({ s }) => s);
  // Newest first within the total budget; an older message that no longer fits is omitted.
  const kept: typeof all = []; let total = 0;
  for (const s of [...all].reverse()) {
    const size = Math.min(s.text.length, maxChars);
    if (kept.length >= limit || total + size > maxTotal) break;
    kept.unshift(s); total += size;
  }
  const omitted = kept.length < all.length;
  return kept.map((s, index) => ({ at: s.at, text: s.text.slice(0, maxChars),
    ...(omitted && index === 0 || s.text.length > maxChars ? { truncated: true as const } : {}) }));
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
      // An unfinished todo is not a rolling cursor: retitling it ("TEST-266" -> "TEST-267" ...)
      // hides progress and never reaches an end. Settle it with its outcome and add a new todo.
      if (!["done", "omitted"].includes(prior.status) && !["done", "omitted"].includes(next.status) && next.title !== prior.title)
        throw Error("Unfinished todos keep their title; settle it with an outcome and add a new todo instead");
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
