import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

/** Aggregated token, duration and tool activity of one dispatcher worker run. */
export interface WorkerMetrics {
  model: string;
  thinkingLevel: string;
  assistantTurns: number;
  inputTokens: number;
  outputTokens: number;
  reasoningChars: number;
  durationMs: number;
  toolCalls: number;
}

interface UsageLike {
  input?: number;
  output?: number;
  total?: number;
  totalTokens?: number;
}

interface ContentItemLike {
  type?: string;
  thinking?: string;
  text?: string;
}

interface MessageLike {
  role?: string;
  model?: string;
  thinkingLevel?: string;
  durationMs?: number;
  usage?: UsageLike;
  content?: ContentItemLike[];
}

interface SessionRecordLike {
  message?: MessageLike;
  role?: string;
}

function distinctJoined(values: string[]): string {
  const seen: string[] = [];
  for (const value of values) if (value && !seen.includes(value)) seen.push(value);
  return seen.join(", ");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

/** Sorted absolute paths of all directories in <home>/sessions named dispatch_<taskId>_*. */
export function locateWorkerSessionDirs(home: string, taskId: string): string[] {
  const sessionsDir = path.join(home, "sessions");
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefix = `dispatch_${taskId}_`;
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => path.join(sessionsDir, entry.name))
    .sort();
}

/** Aggregates all *.jsonl files of one worker session dir; a missing dir yields zeros. */
export function readWorkerMetrics(sessionDir: string): WorkerMetrics {
  const metrics: WorkerMetrics = {
    model: "",
    thinkingLevel: "",
    assistantTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningChars: 0,
    durationMs: 0,
    toolCalls: 0,
  };
  let files: string[];
  try {
    files = readdirSync(sessionDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(entry => entry.name)
      .sort();
  } catch {
    return metrics;
  }
  const models: string[] = [];
  const thinkingLevels: string[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(path.join(sessionDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as SessionRecordLike;
      const message = (record.message ?? record) as MessageLike;
      if (message.role !== "assistant") continue;
      const usage = record.message?.usage;
      if (!usage || typeof usage.totalTokens !== "number" || !(usage.totalTokens > 0)) continue;
      metrics.assistantTurns += 1;
      metrics.inputTokens += typeof usage.input === "number" ? usage.input : 0;
      metrics.outputTokens += typeof usage.output === "number" ? usage.output : 0;
      metrics.durationMs += typeof message.durationMs === "number" ? message.durationMs : 0;
      if (typeof message.model === "string") models.push(message.model);
      if (typeof message.thinkingLevel === "string") thinkingLevels.push(message.thinkingLevel);
      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (typeof item !== "object" || item === null) continue;
          if (item.type === "toolCall") metrics.toolCalls += 1;
          else if (item.type === "thinking") {
            const text = typeof item.thinking === "string" ? item.thinking : typeof item.text === "string" ? item.text : "";
            metrics.reasoningChars += text.length;
          }
        }
      }
    }
  }
  metrics.model = distinctJoined(models);
  metrics.thinkingLevel = distinctJoined(thinkingLevels);
  return metrics;
}

/** Aggregates per-run metrics; an empty input yields an all-zero summary. */
export function summarizeMetrics(runs: WorkerMetrics[]): {
  runs: number;
  assistantTurns: number;
  inputTokens: number;
  outputTokens: number;
  reasoningChars: number;
  toolCalls: number;
  durationMs: { min: number; median: number; p95: number; max: number; total: number };
  outputTokensMedian: number;
} {
  const durations = runs.map(run => run.durationMs);
  const sum = (key: "assistantTurns" | "inputTokens" | "outputTokens" | "reasoningChars" | "toolCalls") =>
    runs.reduce((acc, run) => acc + run[key], 0);
  return {
    runs: runs.length,
    assistantTurns: sum("assistantTurns"),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningChars: sum("reasoningChars"),
    toolCalls: sum("toolCalls"),
    durationMs: {
      min: durations.length ? Math.min(...durations) : 0,
      median: median(durations),
      p95: p95(durations),
      max: durations.length ? Math.max(...durations) : 0,
      total: durations.reduce((acc, value) => acc + value, 0),
    },
    outputTokensMedian: median(runs.map(run => run.outputTokens)),
  };
}
