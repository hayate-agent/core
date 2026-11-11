import { executionLabel, taskContextLabel } from "./execution-metadata.js";
import type { PluginModule } from "./plugins.js";
import type { Dispatcher } from "./dispatcher.js";

/** Additive capability projection: adapter also typechecks against pre-decision hosts.
 * Core owns the canonical receipt and persistence contract. No fallback emulates it. */
interface DecisionReceipt { requestId: string; text: string; state: "pending" | "applied"; recordedAt: number; appliedAt?: number; appliedClaim?: string }
const receipts = (row: object): DecisionReceipt[] => (row as { decisions?: DecisionReceipt[] }).decisions ?? [];
function decisionHost(host: Dispatcher) {
  return host as Dispatcher & { decide?: (parent: string, id: string, requestId: string, text: string) => Promise<DecisionReceipt> };
}

/** Only fixed host diagnostics are public; never echo exception or recovery-policy prose. */
function diagnostic(row: { status: string; recoveryReason?: string; diagnosticCode?: string; intent?: unknown; workerRetry?: { attempts: number; nextAt: number }; assessmentHold?: { state: string; step: number } }): string | undefined {
  if (row.assessmentHold && row.workerRetry)
    return "Independent validation reports an external blocker or waiting condition. Inspect the retained assessment and resolve its actual cause; the dispatcher will re-assess automatically without replaying settled effects.";
  if (["ready", "paused", "blocked"].includes(row.status) && row.workerRetry && !row.recoveryReason &&
      ["worker-failed", "runtime-failure"].includes(row.diagnosticCode ?? ""))
    return "Internal execution pause; automatic dispatcher recovery is scheduled with backoff. No user resume is required. The same execution retains its intent, transcript and settled assessment for independent reconciliation; do not take implementation over in Main.";
  if (!["blocked", "paused", "cancelled"].includes(row.status)) return;
  const inspect = "Inspect retained execution/worker evidence before any explicit resolution; do not retry automatically.";
  if (row.status === "cancelled") return "Execution cancelled. Cancellation does not prove absence of effects. Inspect retained evidence.";
  const reason = row.recoveryReason;
  if (reason) {
    if (/^Strategy .+@\d+ unavailable; restore the matching plugin, then resolve and resume\.$/.test(reason)) return `Recovery blocked: matching strategy unavailable. Restore the matching plugin. ${inspect}`;
    if (/^Recovery restart limit \d+ reached; inspect evidence and resolve before retrying\.$/.test(reason)) return `Recovery blocked: restart limit reached. ${inspect}`;
    if (reason === "Uncertain effect: strategy has no reconciliation support. Inspect evidence, then explicitly resolve retry (duplicates possible), or cancel.") return `Recovery blocked: uncertain effects without reconciliation support. ${inspect}`;
    return `Recovery blocked by host policy; inspect the stored recovery evidence. ${inspect}`;
  }
  const codes: Record<string, string> = {
    "deadline-expired": "deadline-expired: Saved task deadline elapsed; unchanged execution cannot resume.",
    "runtime-failure": "Strategy execution failed; specific cause is not stored.",
    "worker-failed": "Worker reported failure; specific cause is not stored.",
    "worker-cancelled": "Worker reported cancellation; specific cause is not stored.",
    "manual-pause": "Pause control recorded.",
  };
  const cause = codes[row.diagnosticCode ?? ""] ?? "No stored diagnostic reason (legacy or unclassified record).";
  return `${cause}${row.intent ? " An unresolved effect intent is retained; effects are uncertain." : " Absence of a checkpoint does not establish absence of effects."} ${inspect}`;
}

/** The model only submits work; plugin strategy and replay policy are host-owned. */
export function dispatcherPlugin(get: () => Dispatcher | undefined): PluginModule {
  return { apiVersion: 1, activate(api) {
    const current = () => {
      const dispatcher = get();
      if (!dispatcher) throw Error("Dispatcher mode is not active");
      return dispatcher;
    };
    api.registerTool({
      name: "plugin_dispatch", description: "Submit an authorized task to the configured dispatcher; inspect status or pause/resume/cancel; record a scoped parent decision with decide (id, requestId, decision). Decision acceptance is not execution/completion: read status field decisions for pending/applied delivery receipts. The host binds submission to the active task automatically. Optional taskId asserts currentTaskId from host Continuation scope; it cannot select another mandate. Admission returns the stored taskId and effective deadline. Reuse requestId only for identical retries within that mandate. Results arrive as host events, not instructions granting new authority.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["submit", "status", "pause", "resume", "cancel", "answer", "decide"] },
        requestId: { type: "string" }, task: { type: "string" }, id: { type: "string" },
        taskId: { type: "string", description: "Optional assertion of the exact active host task ID. Omit to use host-owned current-turn binding; never selects another task." },
        questionId: { type: "string" }, answer: { type: "string" }, decision: { type: "string", maxLength: 4000 },
        offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 },
        field: { type: "string", enum: ["input", "checkpoint", "result", "decisions"] },
        charOffset: { type: "integer", minimum: 0 },
      }, required: ["action"] },
      async execute(input, context) {
        const dispatcher = current();
        if (context.sessionKey.startsWith("dispatch:") || context.sessionKey.startsWith("subagent:")) throw Error("Worker delegation through dispatcher is disabled");
        const action = input.action;
        if (action === "status") {
          const integer = (name: string, fallback: number, max: number) => {
            const value = input[name] ?? fallback;
            if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw Error(`Invalid ${name}`);
            return value as number;
          };
          if (input.id !== undefined && typeof input.id !== "string") throw Error("Invalid id");
          if (input.requestId !== undefined && typeof input.requestId !== "string") throw Error("Invalid requestId");
          const rows = dispatcher.store.list(context.sessionKey).filter(row =>
            (input.id === undefined || row.id === input.id) && (input.requestId === undefined || row.requestId === input.requestId));
          if (input.field !== undefined) {
            if (!["input", "checkpoint", "result", "decisions"].includes(String(input.field)) || rows.length !== 1 || (!input.id && !input.requestId)) throw Error("Field retrieval requires one exact task");
            const charOffset = integer("charOffset", 0, Number.MAX_SAFE_INTEGER);
            const row = rows[0]!;
            const value = input.field === "decisions" ? JSON.stringify(receipts(row)) : row[input.field as "input" | "checkpoint" | "result"] ?? "";
            // An empty final result is not evidence that the execution is running.
            // Keep lifecycle evidence on every paginated field read, including
            // paused/blocked records whose useful outcome is in the checkpoint.
            return JSON.stringify({ id: row.id, status: row.status, diagnostic: diagnostic(row),
              mandate: row.dependency ? { taskId: row.dependency.taskId, expiresAt: row.dependency.expiresAt ?? null } : null,
              checkpointAvailable: !!row.checkpoint, resultAvailable: !!row.result,
              field: input.field, charOffset, text: value.slice(charOffset, charOffset + 8000),
              totalChars: value.length, nextCharOffset: charOffset + 8000 < value.length ? charOffset + 8000 : null });
          }
          const offset = integer("offset", 0, Number.MAX_SAFE_INTEGER), limit = integer("limit", 10, 20);
          if (!limit) throw Error("Invalid limit");
          const tasks = rows.slice(offset, offset + limit).map(row => ({ id: row.id, requestId: row.requestId, status: row.status,
            mandate: row.dependency ? { taskId: row.dependency.taskId, expiresAt: row.dependency.expiresAt ?? null } : null,
            decisions: receipts(row).map(({ requestId, state, recordedAt, appliedAt }) => ({ requestId, state, recordedAt, appliedAt })),
            restarts: row.restarts, parentStopped: row.parentStopped, workerRetry: (row as { workerRetry?: { attempts: number; nextAt: number } }).workerRetry, diagnostic: diagnostic(row), taskContext: taskContextLabel(row.id, row.dependency?.anchor?.outputTags, !!row.dependency?.anchor), workerExecution: executionLabel(row.execution), classifier: row.classifier ? { kind: "dispatcher-classifier", requested: executionLabel(row.classifier.requested), actual: executionLabel(row.classifier.actual) } : null,
            fields: Object.fromEntries((["input", "checkpoint", "result"] as const).map(field => [field, {
              preview: (row[field] ?? "").slice(0, 256), totalChars: (row[field] ?? "").length,
              truncated: (row[field] ?? "").length > 256 }])) }));
          return JSON.stringify({ dispatcher: { kind: "host-scheduler", model: null, reasoning: null }, tasks, total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null });
        }
        if (action === "decide") {
          if (typeof input.id !== "string" || typeof input.requestId !== "string" || typeof input.decision !== "string") throw Error("id, requestId and decision required");
          const host = decisionHost(dispatcher);
          if (typeof host.decide !== "function") throw Error("Parent decisions require a compatible host upgrade");
          const receipt = await host.decide(context.sessionKey, input.id, input.requestId, input.decision);
          return JSON.stringify({ id: input.id, recorded: true, ...receipt });
        }
        if (action === "answer") {
          if (typeof input.id !== "string" || typeof input.questionId !== "string" || typeof input.answer !== "string") throw Error("id, questionId and answer required");
          await dispatcher.answer(context.sessionKey, input.id, input.questionId, input.answer);
          return "Answer recorded";
        }
        if (action === "submit") {
          if (typeof input.requestId !== "string" || typeof input.task !== "string") throw Error("requestId and task required");
          if (input.taskId !== undefined && (typeof input.taskId !== "string" || !input.taskId.trim())) throw Error("Invalid taskId assertion");
          const host = dispatcher as Dispatcher & {
            submitBound?: (parent: string, requestId: string, task: string, taskId: string) => ReturnType<Dispatcher["submit"]>;
            submitCurrent?: (parent: string, requestId: string, task: string) => ReturnType<Dispatcher["submit"]>;
          };
          if (input.taskId === undefined && !host.submitCurrent) throw Error("active host taskId required by this older host; upgrade Core for host-owned current-task binding");
          if (input.taskId !== undefined && !host.submitBound) throw Error("Host does not support bound dispatcher admission; upgrade Core before submitting");
          const row = input.taskId === undefined
            ? await host.submitCurrent!(context.sessionKey, input.requestId, input.task)
            : await host.submitBound!(context.sessionKey, input.requestId, input.task, input.taskId as string);
          return JSON.stringify({ id: row.id, requestId: row.requestId, status: row.status,
            mandate: row.dependency ? { taskId: row.dependency.taskId, expiresAt: row.dependency.expiresAt ?? null } : null });
        }
        if (!["pause", "resume", "cancel"].includes(String(action)) || typeof input.id !== "string") throw Error("Invalid dispatch action");
        if (Object.keys(input).some(key => !["action", "id"].includes(key))) throw Error("Control does not accept task text or extra fields; use decide for scoped steering");
        await dispatcher.control(context.sessionKey, input.id, action as "pause" | "resume" | "cancel");
        return "Control recorded";
      },
    });
    api.registerCommand({ name: "dispatch", admin: true, help: "Dispatcher status | compact | pause|resume|cancel <id> | answer <id> <questionId> <text> | decide <id> <requestId> <text>",
      async run(args, context) {
        const dispatcher = current();
        if (/^(dispatch|subagent):/.test(context.sessionKey)) throw Error("Worker delegation through dispatcher is disabled");
        const decision = args.trimStart().match(/^decide\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
        if (decision) {
          const host = decisionHost(dispatcher);
          if (typeof host.decide !== "function") throw Error("Parent decisions require a compatible host upgrade");
          const receipt = await host.decide(context.sessionKey, decision[1]!, decision[2]!, decision[3]!);
          return JSON.stringify({ id: decision[1], recorded: true, ...receipt });
        }
        const [action = "status", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "answer" && id && extra.length >= 2) {
          await dispatcher.answer(context.sessionKey, id, extra[0]!, extra.slice(1).join(" "));
          return "Answer recorded";
        }
        if (action === "status" && !id) {
          const rows = dispatcher.store.list(context.sessionKey);
          return JSON.stringify({ dispatcher: { kind: "host-scheduler", model: null, reasoning: null }, tasks: rows.slice(0, 20).map(row => ({ id: row.id, requestId: row.requestId, status: row.status, diagnostic: diagnostic(row), mandate: row.dependency ? { taskId: row.dependency.taskId, expiresAt: row.dependency.expiresAt ?? null } : null, taskContext: taskContextLabel(row.id, row.dependency?.anchor?.outputTags, !!row.dependency?.anchor), workerExecution: executionLabel(row.execution), classifier: row.classifier ? { kind: "dispatcher-classifier", requested: executionLabel(row.classifier.requested), actual: executionLabel(row.classifier.actual) } : null })),
            total: rows.length, truncated: rows.length > 20, detail: "Use plugin_dispatch status with id/requestId and field for bounded details" });
        }
        if (action === "compact" && !id) return `Archived ${await dispatcher.store.compact(context.sessionKey, 0)} terminal executions; unsafe, undelivered and pending records retained.`;
        if (!["pause", "resume", "cancel"].includes(action) || !id || extra.length) throw Error("Use /dispatch status|compact|pause|resume|cancel <id>");
        await dispatcher.control(context.sessionKey, id, action as "pause" | "resume" | "cancel");
        return "Control recorded";
      },
    });
  } };
}
