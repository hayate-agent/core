import type { TurnOutcome } from "./types.js";

/** Conversation identity is supplied by the host, never by model arguments. */
export interface MemoryContext { sessionKey: string }
export type MemoryState = "active" | "revoked" | "archived";
export interface MemoryEntry {
  id: string;
  revision: string;
  sessionKey: string;
  title: string;
  text: string;
  kind: "note" | "lesson" | "decision" | "operation";
  verification: "reported" | "observed";
  source: string;
  createdAt: string;
  updatedAt: string;
  reviewAfter?: string;
  expiresAt?: string;
  state: MemoryState;
  links: string[];
}
export interface MemoryWrite {
  /** Idempotency key scoped to the conversation. Reusing with different content fails. */
  key: string;
  title: string;
  text: string;
  kind?: MemoryEntry["kind"];
  source: string;
  reviewAfter?: string;
  expiresAt?: string;
  links?: string[];
}
export interface MemoryHit { entry: MemoryEntry; score: number; reviewDue: boolean }
export interface MemoryStatus {
  provider: string;
  entries: number;
  indexed: number;
  ready: boolean;
  semantic: "ready" | "disabled" | "degraded";
  lastScan?: string;
  error?: string;
}
/** Provider v1: durable writes, isolated reads, bounded hybrid retrieval. No backend paths in API. */
export interface MemoryProvider {
  readonly capabilities: { semantic: boolean; revisions: boolean };
  put(context: MemoryContext, input: MemoryWrite): Promise<MemoryEntry>;
  get(context: MemoryContext, id: string): Promise<MemoryEntry | undefined>;
  search(context: MemoryContext, query: string, options?: { limit?: number; historical?: boolean }): Promise<MemoryHit[]>;
  /** Optimistic concurrency required; preserves the original ID and source. */
  revise(context: MemoryContext, id: string, revision: string, patch: { state?: MemoryState; text?: string; reviewAfter?: string; expiresAt?: string }): Promise<MemoryEntry>;
  /** Erases the entry and its derived vectors, not just an archive flag. */
  forget(context: MemoryContext, id: string, revision: string): Promise<void>;
  status(): Promise<MemoryStatus>;
  reindex(): Promise<void>;
  close(): Promise<void>;
}
export interface MemoryConfig {
  enabled: boolean;
  provider: string;
  /** Startup-selected recall/capture implementation; none disables orchestration only. */
  orchestration?: string;
  autoCapture: boolean;
  autoRecall: boolean;
  scanSeconds: number;
  maxEntries: number;
  maxIndexBytes: number;
  /** Max memory excerpts injected per turn by auto-recall. */
  recallLimit: number;
  embedding?: { url: string; model: string; tokenEnv?: string; dimensions?: number };
}
export function memoryConfig(input: Partial<MemoryConfig> = {}): MemoryConfig {
  const config: MemoryConfig = { enabled: true, provider: "local", orchestration: "default", autoCapture: true, autoRecall: true, scanSeconds: 60, maxEntries: 10000, maxIndexBytes: 64 * 1024 * 1024, recallLimit: 3, ...input };
  for (const key of ["enabled", "autoCapture", "autoRecall"] as const) if (typeof config[key] !== "boolean") throw Error(`Invalid memory.${key}`);
  if (config.orchestration !== undefined && (typeof config.orchestration !== "string" || !/^[a-z][a-z0-9_-]*$/.test(config.orchestration))) throw Error("Invalid memory.orchestration");
  if (!/^[a-z][a-z0-9_-]*$/.test(config.provider)) throw Error("Invalid memory.provider");
  for (const [key, min, max] of [["scanSeconds", 5, 86400], ["maxEntries", 1, 100000], ["maxIndexBytes", 65536, 512 * 1024 * 1024], ["recallLimit", 1, 20]] as const) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw Error(`Invalid memory.${key}`);
  }
  if (config.embedding) {
    const e = config.embedding;
    if (!e.model || e.model.length > 200 || !/^https?:$/.test(new URL(e.url).protocol) || (e.dimensions !== undefined && (!Number.isInteger(e.dimensions) || e.dimensions < 1 || e.dimensions > 8192))) throw Error("Invalid memory.embedding");
    if (e.tokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(e.tokenEnv)) throw Error("Invalid memory.embedding.tokenEnv");
  }
  return config;
}
export interface MemoryTurn { id?: string; sessionKey: string; text: string; reply: string; tools?: number; recordedAt?: number; outcome: TurnOutcome | "completed" }
export type MemoryProviderFactory = (context: { home: string; config: MemoryConfig }) => Promise<MemoryProvider>;
