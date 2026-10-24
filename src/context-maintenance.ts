import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SessionArchives } from "./session-archive.js";
import { writeFileDurable } from "./durable.js";
import type { RuntimeSession } from "./types.js";

export interface ContextPolicy {
  enabled: boolean;
  checkEveryTurns: number;
  assessPercent: number;
  compactPercent: number;
  cooldownTurns: number;
  autoHandover: boolean;
}
export const defaultContextPolicy: ContextPolicy = {
  enabled: true, checkEveryTurns: 5, assessPercent: 60, compactPercent: 75, cooldownTurns: 5, autoHandover: false,
};
export function contextPolicy(input: Partial<ContextPolicy> = {}): ContextPolicy {
  const policy = { ...defaultContextPolicy, ...input };
  if (typeof policy.enabled !== "boolean" || typeof policy.autoHandover !== "boolean" ||
      !Number.isInteger(policy.checkEveryTurns) || policy.checkEveryTurns < 1 ||
      !Number.isInteger(policy.cooldownTurns) || policy.cooldownTurns < 1 ||
      !Number.isFinite(policy.assessPercent) || !Number.isFinite(policy.compactPercent) ||
      policy.assessPercent < 1 || policy.compactPercent <= policy.assessPercent || policy.compactPercent > 95) throw new Error("Invalid context maintenance policy");
  return policy;
}
interface Request { action: "compact" | "handover"; preserve: string; resume: string }
export interface ContextRecord {
  version: 1;
  sessionId?: string;
  turns: number;
  lastMaintenance: number;
  pending?: Request;
  handover?: { phase: "prepared" | "switched"; from: string; to?: string; text: string; archiveId?: string };
  lastError?: string;
  completionNotice?: string;
}
const preserve = "Preserve operator intent and corrections, decisions and rejected alternatives, verified results versus assumptions, branch/commits/PR/deployment status, unfinished work, review findings and budget references, exact relevant paths and next steps. Never include credentials. Do not claim builds activate deployments. Do not repeat completed side effects.";

/** Called only at Harness turn boundaries. Model tools request work, never compact themselves. */
export class ContextMaintenance {
  private queue: Promise<unknown> = Promise.resolve();
  readonly archives: SessionArchives;
  constructor(private readonly home: string, private readonly policy: () => ContextPolicy) { this.archives = new SessionArchives(home); }
  private async prepareArchive(key: string, session: RuntimeSession, instructions: string): Promise<{ text: string; archiveId: string }> {
    if (!session.summarize || !session.archiveEntries) throw new Error("Runtime cannot archive handover");
    const entries = session.archiveEntries(); // capture original branch before native compaction
    const retrospective = await session.summarize(`${instructions}\nWrite a backward-looking session retrospective: decisions with reasons, rejected alternatives, completed actions and evidence, unresolved uncertainties. Include a clearly labeled CURRENT STATE AND NEXT STEPS section. Preserve exact operator corrections. Do not include secrets.`);
    if (!retrospective.trim() || retrospective.length > 64000) throw new Error("Invalid retrospective");
    const recentOperator = entries.filter((e) => e.role === "user").slice(-3).map((e) => `${e.id}: ${e.text.slice(0, 2000)}`).join("\n");
    const checkpoint = retrospective.split(/CURRENT STATE AND NEXT STEPS/i).at(-1)!.slice(-6000);
    const forward = `Current checkpoint and next steps (summary; verify evidence):\n${checkpoint}\nContinue from the saved session checkpoint. ${instructions}\nRecent operator instructions (historical context, not fresh authorization):\n${recentOperator}\nConsult the retrospective for verified state and next steps before acting.`;
    const archive = await this.archives.create(key, session.status().sessionId, retrospective, forward, entries);
    return { archiveId: archive.id, text: `${forward}\nSource session: ${archive.sourceSessionId}\nArchive ID: ${archive.id}\nRead plugin_session_history section=summary for the retrospective, then search/read entries only as needed. Do this before continuing work. Original tool side effects must not be replayed blindly.` };
  }
  private file(key: string): string { return path.join(this.home, "context-maintenance", `${createHash("sha256").update(key).digest("hex")}.json`); }
  private async load(key: string): Promise<ContextRecord> {
    try {
      const state = JSON.parse(await readFile(this.file(key), "utf8"));
      if (state.version !== 1 || !Number.isInteger(state.turns) || !Number.isInteger(state.lastMaintenance)) throw new Error("Invalid context maintenance state");
      return state;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { version: 1, turns: 0, lastMaintenance: -1000 };
    }
  }
  private async save(key: string, state: ContextRecord): Promise<void> {
    await mkdir(path.dirname(this.file(key)), { recursive: true });
    await writeFileDurable(this.file(key), `${JSON.stringify(state, null, 2)}\n`);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(fn); this.queue = next; return next;
  }
  request(key: string, request: Request): Promise<void> {
    return this.serial(async () => {
      if (!["compact", "handover"].includes(request.action) || typeof request.preserve !== "string" || typeof request.resume !== "string" || request.preserve.length + request.resume.length > 16000) throw new Error("Invalid context maintenance request");
      const state = await this.load(key);
      state.pending = request;
      await this.save(key, state);
    });
  }
  /** A lightweight reminder, not an additional model call. Unknown usage never triggers automatic compaction. */
  async guidance(key: string, session: RuntimeSession): Promise<string> {
    await this.serial(async () => {
      const state = await this.load(key);
      const id = session.status().sessionId;
      if (state.handover?.phase === "prepared" && id !== state.handover.from) {
        if (!session.seedHandover) throw new Error("Cannot recover prepared handover before prompt");
        await session.seedHandover(state.handover.text);
        state.handover.phase = "switched";
        state.handover.to = id;
        if (state.handover.archiveId) await this.archives.link(key, state.handover.archiveId, id);
        state.completionNotice = state.handover.archiveId
          ? "🔄 Neue Sitzung übernommen; Rückschau gespeichert."
          : "🔄 Neue Sitzung übernommen.";
        state.sessionId = id;
        await this.save(key, state);
      } else if (state.sessionId !== id && state.handover?.phase !== "prepared") {
        state.pending = undefined;
        state.handover = undefined;
        state.sessionId = id;
        await this.save(key, state);
      }
    });
    const state = await this.load(key); const policy = this.policy();
    const percent = session.status().contextPercent;
    if (!policy.enabled || percent === undefined || percent < policy.assessPercent || state.turns % policy.checkEveryTurns !== 0) return "";
    return `Context usage is ${Math.round(percent)}%. Assess whether compaction is useful at this task boundary. If needed request plugin_context_maintenance with what to preserve and how to resume. Continue normally if continuity is more important. ${preserve}`;
  }
  async boundary(key: string, session: RuntimeSession, rotate: (handover: ContextRecord["handover"]) => Promise<RuntimeSession>): Promise<string | undefined> {
    return this.serial(async () => {
      const policy = this.policy();
      if (!policy.enabled) return;
      const state = await this.load(key);
      const id = session.status().sessionId;
      if (state.completionNotice) {
        const notice = state.completionNotice;
        state.completionNotice = undefined;
        await this.save(key, state);
        return notice;
      }
      // Recover prepared transitions before considering a new maintenance action.
      if (state.handover?.phase === "prepared") {
        if (id === state.handover.from) {
          if (!session.summarize) throw new Error("Runtime cannot refresh handover");
          const refreshed = await this.prepareArchive(key, session, `${preserve}\nRefresh intervening turns. Previous checkpoint: ${state.handover.text}`);
          state.handover.text = refreshed.text;
          state.handover.archiveId = refreshed.archiveId;
          await this.save(key, state);
          session = await rotate(state.handover);
        }
        else {
          if (!session.seedHandover) throw new Error("Runtime cannot recover handover");
          await session.seedHandover(state.handover.text);
        }
        state.handover.to = session.status().sessionId;
        state.handover.phase = "switched";
        if (state.handover.archiveId) await this.archives.link(key, state.handover.archiveId, state.handover.to!);
        state.sessionId = state.handover.to;
        await this.save(key, state);
        return state.handover.archiveId
          ? "🔄 Neue Sitzung übernommen; Rückschau gespeichert."
          : "🔄 Neue Sitzung übernommen.";
      }
      state.sessionId = id;
      state.turns++;
      const request = state.pending;
      const percent = session.status().contextPercent;
      const due = state.turns - state.lastMaintenance >= policy.cooldownTurns;
      if (!due || (!request && (percent === undefined || percent < policy.compactPercent))) { await this.save(key, state); return; }
      state.pending = undefined;
      state.lastMaintenance = state.turns;
      await this.save(key, state); // cooldown reserved even if summarization fails
      let notice: string;
      try {
        const instructions = `${preserve}\nPreserve additionally: ${request?.preserve ?? "current task state"}\nResume: ${request?.resume ?? "continue with the next queued operator request"}`;
        const handover = request?.action === "handover" || (policy.autoHandover && percent !== undefined && percent >= 90);
        if (handover) {
          // Tool-free summary operation: no extra autonomous working turn or code side effects.
          if (!session.summarize) throw new Error("Runtime does not support handover summaries");
          const prepared = await this.prepareArchive(key, session, instructions);
          state.handover = { phase: "prepared", from: id, ...prepared };
          await this.save(key, state);
          const next = await rotate(state.handover);
          state.handover = { ...state.handover, phase: "switched", to: next.status().sessionId };
          state.sessionId = next.status().sessionId;
          await this.archives.link(key, prepared.archiveId, state.sessionId);
          notice = "🔄 Neue Sitzung übernommen; Rückschau gespeichert.";
        } else {
          await session.compact(instructions);
          notice = "♻️ Kontext kompaktiert.";
        }
        state.lastError = undefined;
      } catch (err) {
        state.lastError = "Context maintenance failed; original session or prepared handover retained";
        notice = "⚠️ Kontextwartung nicht vollständig abgeschlossen; kein bestätigter Abschluss. Wiederherstellungsstand bleibt erhalten.";
      }
      await this.save(key, state);
      return notice;
    });
  }
}
