import { createServer, type Socket } from "node:net";
import { mkdir, lstat, chmod, unlink, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { writeFileDurable } from "./durable.js";
import { validExecutionFollowUp, executionDecisionRevision } from "./execution.js";
import type { Dispatcher } from "./dispatcher.js";
import type { PluginModule } from "./plugins.js";

/** Local host-owner control, deliberately NOT an inference API or model tool.
 * Same-UID filesystem authority is required, as for native lifecycle control.
 * It never edits a ledger or bypasses Dispatcher decision/admission checks. */
export function executionControlPlugin(get: () => Dispatcher | undefined, directory: string,
  resetConversation?: (parent: string) => Promise<void>): PluginModule {
  return { apiVersion: 1, async activate(api) {
    if (!process.getuid) return;
    try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    // Kubernetes fsGroup can re-add group permissions on every PVC remount.
    // Tighten only our actual owned directory, through a no-follow descriptor;
    // never bless a symlink, foreign owner or replaced path as a control root.
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const dir = await handle.stat();
      if (!dir.isDirectory() || dir.uid !== process.getuid()) throw Error("Unsafe execution control directory");
      if ((dir.mode & 0o7777) !== 0o700) await handle.chmod(0o700);
      const sealed = await handle.stat(), named = await lstat(directory);
      if ((sealed.mode & 0o7777) !== 0o700 || !named.isDirectory() ||
          named.dev !== sealed.dev || named.ino !== sealed.ino || named.uid !== process.getuid()) throw Error("Unsafe execution control directory");
    } finally { await handle.close(); }
    const endpoint = path.join(directory, `o-${randomUUID().slice(0, 12)}.sock`), clients = new Set<Socket>(), requests = new Set<Promise<void>>();
    let closed = false, ready = false, identity: Awaited<ReturnType<typeof lstat>> | undefined;
    const server = createServer(socket => {
      if (!ready || closed || clients.size >= 8 || requests.size >= 8) { socket.destroy(); return; }
      clients.add(socket); socket.setTimeout(10000, () => socket.destroy()); socket.setEncoding("utf8");
      socket.on("error", () => socket.destroy()); socket.on("close", () => clients.delete(socket));
      let buffer = "", submitted = false;
      socket.on("data", chunk => {
        if (submitted || closed) { socket.destroy(); return; }
        buffer += chunk; if (Buffer.byteLength(buffer) > 8000) { socket.destroy(); return; }
        const end = buffer.indexOf("\n"); if (end < 0) return;
        submitted = true;
        const request = (async () => {
          try {
            if (buffer.slice(end + 1).length) throw Error("One request per connection");
            const frame = JSON.parse(buffer.slice(0, end));
            if (frame?.op === "reset-conversation") socket.setTimeout(0); // owned script drain may take its full deadline
            const result = await executionControlRequest(get(), frame, resetConversation);
            if (!closed && !socket.destroyed) socket.end(JSON.stringify({ ok: true, result }) + "\n");
          } catch { if (!socket.destroyed) socket.end('{"ok":false,"error":"request rejected; inspect exact execution and ownership before retry"}\n'); }
        })();
        requests.add(request); void request.finally(() => requests.delete(request));
      });
    });
    api.onStop(async () => {
      closed = true; for (const socket of clients) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      await Promise.allSettled([...requests]);
      if (identity) try { const now = await lstat(endpoint); if (now.dev === identity.dev && now.ino === identity.ino) await unlink(endpoint); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => { server.off("error", reject); resolve(); }); });
    server.on("error", () => { for (const socket of clients) socket.destroy(); });
    identity = await lstat(endpoint); await chmod(endpoint, 0o600); ready = true;
    // Unique endpoints tolerate an earlier process crash without ever unlinking
    // an unknown/live socket. The private atomic pointer is replaced on startup.
    await writeFileDurable(path.join(directory, "owner.json"), JSON.stringify({ version: 1, pid: process.pid, socket: path.basename(endpoint) }) + "\n");
  } };
}

/** Bounded exact request; idempotent receipt retries precede the revision fence.
 * Explicit consolidation reuses existing audited same-owner follow-up admission.
 * No resume/cancel, deadline extension, original-scope replacement or new job. */
export async function executionControlRequest(dispatcher: Dispatcher | undefined, input: unknown,
  resetConversation?: (parent: string) => Promise<void>): Promise<unknown> {
  if (!dispatcher || !input || typeof input !== "object") throw Error("Dispatcher control unavailable");
  const frame = input as Record<string, unknown>;
  if (typeof frame.parent !== "string" || !frame.parent.trim() || frame.parent.length > 1000 || /^(dispatch|subagent):/.test(frame.parent)) throw Error("Invalid exact parent scope");
  if (frame.op === "reset-conversation") {
    if (!resetConversation || Object.keys(frame).length !== 2) throw Error("Conversation reset unavailable or invalid");
    await resetConversation(frame.parent);
    return { parent: frame.parent, reset: true, previousWorkRevoked: true };
  }
  if (typeof frame.id !== "string" || !/^[a-f0-9-]{36}$/.test(frame.id)) throw Error("Invalid exact execution scope");
  const task = dispatcher.store.list(frame.parent).find(t => t.id === frame.id);
  if (!task) throw Error("Execution not in exact parent scope");
  if (frame.op === "status" && Object.keys(frame).length === 3) return {
    id: task.id, parent: task.parent, status: task.status, revision: executionDecisionRevision(task.decisions), diagnostic: task.diagnosticCode,
    checkpointHash: task.checkpoint ? createHash("sha256").update(task.checkpoint).digest("hex") : undefined,
    expiresAt: task.dependency?.expiresAt, parentStopped: !!task.parentStopped, ownershipHold: !!task.ownershipHold,
  };
  if (frame.op === "reopen-contradiction") {
    if (Object.keys(frame).some(k => !["op", "id", "parent", "expectedRevision", "requestId", "text", "checkpointHash"].includes(k)) ||
        !Number.isSafeInteger(frame.expectedRevision) || Number(frame.expectedRevision) < 0 || typeof frame.requestId !== "string" || typeof frame.text !== "string" || typeof frame.checkpointHash !== "string") throw Error("Invalid exact contradictory-completion reconciliation");
    const restored = await dispatcher.reopenContradictoryCompletion(task.parent, task.id, frame.requestId, frame.text, frame.checkpointHash, Number(frame.expectedRevision));
    return { id: restored.id, status: restored.status, executionStarted: false, reviewOnly: true, note: "Original terminal receipt archived; no effect replay or permission reset. Verify actual same-owner admission separately." };
  }
  const consolidating = frame.op === "consolidate";
  if (frame.op !== "decide" && !consolidating || Object.keys(frame).some(k => !["op", "id", "parent", "expectedRevision", "requestId", "text", ...(consolidating ? ["replaces", "followUp"] : [])].includes(k)) ||
      !Number.isSafeInteger(frame.expectedRevision) || Number(frame.expectedRevision) < 0 || typeof frame.requestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(frame.requestId) || typeof frame.text !== "string" || !frame.text.trim() || Buffer.byteLength(frame.text) > 4000) throw Error("Invalid owner decision");
  if (consolidating && (!Array.isArray(frame.replaces) || !frame.replaces.length || frame.replaces.length > 32 ||
      new Set(frame.replaces).size !== frame.replaces.length || frame.replaces.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) ||
      frame.followUp !== undefined && !validExecutionFollowUp(frame.followUp))) throw Error("Invalid explicit consolidation");
  const prior = await dispatcher.store.readDecision(task.parent, task.id, frame.requestId);
  if (prior) {
    if (prior.text !== frame.text || JSON.stringify(prior.followUp) !== JSON.stringify(frame.followUp) ||
        JSON.stringify(prior.supersedes) !== JSON.stringify(consolidating ? frame.replaces : undefined)) throw Error("Decision identity conflict");
    return { id: task.id, decision: prior, replayed: true, executionStarted: false };
  }
  if (executionDecisionRevision(task.decisions) !== frame.expectedRevision) throw Error("Decision revision changed; reconcile first");
  if (task.parentStopped || task.ownershipHold || task.recoveryEnrollment === "held-legacy" || task.diagnosticCode === "manual-pause" ||
      ["completed", "cancelled"].includes(task.status) || task.question && task.question.answer === undefined ||
      task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= Date.now()) throw Error("Original execution authority held or expired");
  const decision = consolidating
    ? await dispatcher.consolidateDecisions(task.parent, task.id, frame.requestId, frame.text, frame.replaces as string[], frame.followUp as import("./execution.js").ExecutionFollowUp | undefined, Number(frame.expectedRevision))
    : await dispatcher.decide(task.parent, task.id, frame.requestId, frame.text, Number(frame.expectedRevision));
  return { id: task.id, decision, replayed: false, executionStarted: false,
    note: "Recorded only; same-owner independent admission still required. No completion or effect approval." };
}
