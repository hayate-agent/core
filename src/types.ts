/**
 * Core contracts. Nothing in here knows about PI: the runtime is swappable.
 */

/** Where an input came from. */
export type InputSource = "channel" | "cron" | "api" | "heartbeat" | "loop" | "goal";

/** Where a reply goes. `channel` + `target` identify a conversation (e.g. matrix + room id). */
export interface Address {
  channel: string;
  target: string;
  thread?: string;
}

export interface Inbound {
  /** Channel-level id (e.g. Matrix event id) to drop duplicates on redelivery. */
  id?: string;
  /** Several channel messages merged into one turn; seen parts are dropped on redelivery. */
  parts?: Array<{ id: string; text: string }>;
  /** Stable conversation key; one runtime session per key. */
  sessionKey: string;
  text: string;
  source: InputSource;
  /** Durable, bounded continuation plan supplied during this turn. */
  continuation?: { state: "continue" | "waiting" | "blocked" | "completed"; next?: string; expiresAt?: number };
  continuationDepth?: number;
  /** Host-assigned durable task identity, never a model authorization grant. */
  taskId?: string;
  /** Trusted numeric authorization boundary inherited by generated work. */
  continuationExpiresAt?: number;
  /** Core-captured original chat input; inherited by generated follow-ups, never reply text. */
  completionAnchor?: { id: string; task: string; receivedAt: number };
  sender?: string;
  /** Where replies for this input are delivered. */
  replyTo?: Address;
  /** Not addressed to the agent (free/coordination room): answering is optional. */
  replyOptional?: boolean;
  /** Per-turn overrides (API runs); persisted with the inbox. */
  turn?: TurnOptions;
  /** Its turn started and has not finished (persisted: a crash while set counts as a replay). */
  started?: boolean;
  /** Stable first-start timestamp, persisted before execution for replay-safe memory capture. */
  memoryRecordedAt?: number;
  /** Durable logical message identity used by edit-capable gateways across restarts. */
  progressId?: string;
  /** Crashes (OOM, kill) that interrupted this input's turn so far. */
  replays?: number;
}

/** Overrides for a single turn; the session's own settings are restored afterwards. */
export interface TurnOptions {
  /** Extra system instructions for this turn only. */
  instructions?: string;
  /** "provider/model". */
  model?: string;
  thinking?: string;
}

/** Progress of a running turn, for channels that stream it (API runs). */
export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; phase: "start" | "end"; name: string; error?: boolean; detail?: string }
  /** One assistant message finished; usage is for that message only. */
  | {
      type: "usage";
      model?: string;
      thinking?: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number;
    };

export interface PromptOptions extends TurnOptions {
  onEvent?: (event: TurnEvent) => void;
  /** Host-only authorization guard, invoked after asynchronous runtime setup. */
  beforeExecution?: () => void;
}

/** How a turn ended, when it did not simply complete. */
export type TurnOutcome = "failed" | "cancelled";

/** How a message is handled while the session is busy (Hermes `/busy`). */
export type BusyMode = "queue" | "steer" | "interrupt";

export interface RuntimeSessionStatus {
  sessionId: string;
  title?: string;
  sessionFile?: string;
  model?: string;
  thinking?: string;
  busy: boolean;
  messages?: number;
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; total?: number };
  /** Provider/model price estimate for this runtime session, not a billing statement. */
  costUsd?: number;
  contextPercent?: number;
  contextWindow?: number;
  /** Effective runtime system prompt size; excludes conversation history and tool schemas. */
  systemPrompt?: { characters: number; bytes: number };
}

/** One live conversation inside an agent runtime. */
export interface RuntimeSession {
  readonly busy: boolean;
  /** Run one turn to completion (including tool calls) and return the final assistant text. */
  prompt(text: string, options?: PromptOptions): Promise<string>;
  /** Inject into the running turn after the next tool call. */
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  /** Tool-free native summary for handover (may compact the source session). */
  summarize?(instructions: string): Promise<string>;
  archiveEntries?(): import("./session-archive.js").ArchiveEntry[];
  seedHandover?(text: string): Promise<void>;
  setModel(ref: string): Promise<void>;
  setThinking(level: string): void;
  setTitle(title: string): void | Promise<void>;
  status(): RuntimeSessionStatus;
  dispose(): void | Promise<void>;
}

export interface OpenSessionOptions {
  /** Ephemeral reviewer session: no persisted transcript or third-party resources. */
  ephemeral?: boolean;
  /** Start a fresh conversation instead of resuming the stored one. */
  fresh?: boolean;
  sessionId?: string;
}

export interface LoginUI {
  prompt(message: string, secret?: boolean): Promise<string>;
  select(message: string, options: Array<{ id: string; label: string }>): Promise<string>;
  notify(message: string): void;
}

/** Agent runtime (currently PI). */
export interface AgentRuntime {
  readonly name: string;
  open(sessionKey: string, options?: OpenSessionOptions): Promise<RuntimeSession>;
  /** Model refs ("provider/model") usable for per-turn overrides. */
  models?(): Promise<string[]>;
  sessions?(key: string, offset?: number): Promise<import("./sessions.js").SessionSummary[]>;
  login?(ui: LoginUI): Promise<void>;
  /** Re-read persona/skills/config for sessions opened afterwards. */
  reload(): Promise<void>;
}

/**
 * Thrown by Channel.send() when retrying can never succeed (e.g. Matrix 403: no permission in
 * the room). The harness parks such replies instead of blocking the session; any other error
 * is treated as transient and retried.
 */
export class PermanentDeliveryError extends Error {}

/** Extra info for outbound messages. */
export interface SendMeta {
  /** Transport-neutral presentation intent. Adapters render progress subtly (e.g. italic).
   * Progress text is plain text, not channel-specific markup; unsupported adapters may ignore it.
   */
  presentation?: "progress";
  /** Logical identity: adapter resolves it idempotently to its native message reference. */
  progressId?: string;
  /** Message is an approval prompt; channels may resolve it via reactions (→ /approve|/deny <id>). */
  approvalId?: string;
  /** Stable delivery id: retries of the same reply reuse it (channels derive idempotency keys). */
  deliveryId?: string;
  /** The turn behind this reply failed or was cancelled (text is the error/partial output). */
  outcome?: TurnOutcome;
}

/**
 * Channels whose upstream acknowledgement (e.g. a sync cursor) lags acceptance pin the ids of
 * that window so the harness keeps deduplicating them until the checkpoint is durable.
 */
export interface DedupPins {
  pin(ids: Iterable<string>): void;
  unpin(ids: Iterable<string>): void;
}

/** A messaging channel (Matrix, console, ...). */
export interface Channel {
  readonly name: string;
  /** Resolved global/per-gateway policy, applied before start. */
  configureGateway?(settings: import("./gateway-settings.js").GatewaySettings): void;
  /** `deliverInbound` resolves once the input is durably accepted (safe to acknowledge upstream). */
  start(deliverInbound: (input: Inbound) => Promise<void>, dedup?: DedupPins): Promise<void>;
  send(to: Address, text: string, meta?: SendMeta): Promise<void>;
  /** Supports stable logical progress IDs and final replacement through send(). */
  editableProgress?: boolean;
  progressEnabled?(): boolean;
  /** Optional live progress of the turn answering `to` (best effort, not durable). */
  turnEvent?(to: Address, event: TurnEvent, input?: Inbound): void;
  /** Best-effort status on the original input; completed means processing, not delivery. */
  /** Best-effort receipt signal, independent of when queued work starts. */
  received?(to: Address, input: Inbound): Promise<void>;
  turnStatus?(to: Address, input: Inbound, status: "started" | "completed" | "failed" | "cancelled"): Promise<void>;
  /** Optional "is typing" indicator while a turn runs. */
  typing?(to: Address, on: boolean): Promise<void>;
  /** `budgetMs`: give up waiting for in-flight work after this long (bounded shutdown). */
  stop(budgetMs?: number): Promise<void>;
}
