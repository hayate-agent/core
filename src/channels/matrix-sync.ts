import { mkdir, readFile } from "node:fs/promises";
import { appendFileDurable, writeFileDurable } from "../durable.js";
import path from "node:path";
import type { Inbound } from "../types.js";

export interface MatrixEvent {
  type: string;
  event_id: string;
  sender: string;
  content: Record<string, any>;
  origin_server_ts?: number;
}

const MAX_BACKFILL_PAGES = 1000;

/**
 * Owns the durable Matrix /sync checkpoint and the inbox hand-off boundary.
 *
 * Invariants:
 * - `durableCursor` advances only after all inputs before `cursor` were accepted durably.
 * - any failed hand-off rewinds `cursor` to `durableCursor` before another sync.
 * - a limited timeline is returned only after its entire gap has been fetched.
 */
export class MatrixSyncRecovery {
  private cursor?: string;
  private durableCursor?: string;
  private readonly inflight = new Set<Promise<void>>();
  private handOffFailed = false;
  /** Shutdown gave up waiting: nothing may be checkpointed any more in this process. */
  private sealed = false;
  /** Event ids handed off since the durable cursor; they must stay deduplicated until committed. */
  private readonly uncommitted = new Set<string>();
  /** Called with ids that left the uncommitted window (cursor durably passed them). */
  onCommitted?: (ids: string[]) => void;
  /** Called with ids entering the uncommitted window. */
  onHandOff?: (ids: string[]) => void;
  private readonly eventFailures = new Map<string, number>();

  constructor(
    readonly stateFile: string,
    private readonly log: (message: string) => void,
  ) {}

  get since(): string | undefined {
    return this.cursor;
  }

  /** Owner (homeserver + MXID) of the checkpoint; set before load()/commit(). */
  owner?: { homeserver: string; userId: string };

  async load(): Promise<{ found: boolean; threads: string[]; pendingInvites: Record<string, unknown> }> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { found: false, threads: [], pendingInvites: {} };
      throw err;
    }
    const saved = JSON.parse(raw);
    if (saved.homeserver !== undefined || saved.userId !== undefined) {
      if (saved.homeserver !== this.owner?.homeserver || saved.userId !== this.owner?.userId) {
        throw new Error(
          `${this.stateFile} belongs to ${saved.userId} on ${saved.homeserver}, not ${this.owner?.userId} on ${this.owner?.homeserver}; move it away to start fresh`,
        );
      }
    }
    if (typeof saved.since !== "string") throw new Error(`${this.stateFile}: missing sync token`);
    this.cursor = this.durableCursor = saved.since;
    const pendingInvites = saved.pendingInvites && typeof saved.pendingInvites === "object" && !Array.isArray(saved.pendingInvites) ? saved.pendingInvites : {};
    return {
      found: true,
      threads: Array.isArray(saved.threads) ? saved.threads.filter((v: unknown): v is string => typeof v === "string") : [],
      pendingInvites,
    };
  }

  advance(since: string): void {
    this.cursor = since;
  }

  rewind(): void {
    this.cursor = this.durableCursor;
  }

  /** Stop waiting for hand-offs and refuse every later commit (bounded shutdown). */
  seal(): void {
    this.sealed = true;
  }

  pinned(): ReadonlySet<string> {
    return this.uncommitted;
  }

  handOff(input: Inbound, deliver: ((input: Inbound) => Promise<void>) | undefined): void {
    const ids = input.parts?.map((p) => p.id) ?? (input.id ? [input.id] : []);
    for (const id of ids) this.uncommitted.add(id);
    this.onHandOff?.(ids);
    const pending: Promise<void> = (deliver?.(input) ?? Promise.reject(new Error("Matrix input receiver is not ready")))
      .catch((err) => {
        this.handOffFailed = true;
        this.log(`input ${input.id ?? ""} not accepted: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => this.inflight.delete(pending));
    this.inflight.add(pending);
  }

  /** Wait for inbox acceptance and rewind after any failure. */
  async settle(): Promise<boolean> {
    await Promise.all([...this.inflight]);
    if (!this.handOffFailed) return true;
    this.handOffFailed = false;
    this.cursor = this.durableCursor;
    return false;
  }

  /** No hand-off in flight and none failed since the last settle. */
  idle(): boolean {
    return this.inflight.size === 0 && !this.handOffFailed;
  }

  async commit(threads: Iterable<string>, pendingInvites: Record<string, unknown> = {}): Promise<void> {
    if (!this.cursor || this.sealed) return;
    const since = this.cursor; // snapshot before any await: later advances need their own commit
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const state = { ...this.owner, since, threads: [...threads].slice(-500), ...(Object.keys(pendingInvites).length ? { pendingInvites } : {}) };
    await writeFileDurable(this.stateFile, JSON.stringify(state));
    this.durableCursor = since;
    if (since === this.cursor && !this.inflight.size) {
      const done = [...this.uncommitted];
      this.uncommitted.clear();
      this.onCommitted?.(done);
    }
  }

  failure(eventId: string): number {
    const attempts = (this.eventFailures.get(eventId) ?? 0) + 1;
    this.eventFailures.set(eventId, attempts);
    return attempts;
  }

  clearFailure(eventId: string): void {
    this.eventFailures.delete(eventId);
  }

  async backfill(
    roomId: string,
    from: string,
    to: string,
    aborted: () => boolean,
    page: (path: string) => Promise<{ chunk?: MatrixEvent[]; end?: string }>,
  ): Promise<MatrixEvent[]> {
    const out: MatrixEvent[] = [];
    const ids = new Set<string>();
    const filter = encodeURIComponent(JSON.stringify({ types: ["m.room.message", "m.reaction"] }));
    let token: string | undefined = from;
    let complete = false;
    for (let n = 0; token && n < MAX_BACKFILL_PAGES && !aborted(); n++) {
      const result = await page(
        `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100&from=${encodeURIComponent(token)}&to=${encodeURIComponent(to)}&filter=${filter}`,
      );
      for (const event of result.chunk ?? []) if (!ids.has(event.event_id)) (ids.add(event.event_id), out.push(event));
      // An empty (filtered) chunk with a new `end` is not the end of the gap: keep paginating.
      if (!result.end || result.end === token) {
        complete = true;
        break;
      }
      token = result.end;
    }
    if (!complete) throw new Error(`backfill ${roomId}: gap not fully fetched (>${MAX_BACKFILL_PAGES * 100} events or aborted)`);
    return out.reverse();
  }

  async deadLetter(roomId: string, event: MatrixEvent, err: unknown): Promise<void> {
    const file = path.join(path.dirname(this.stateFile), "matrix-deadletter.jsonl");
    const line = JSON.stringify({ at: new Date().toISOString(), roomId, event, error: err instanceof Error ? err.message : String(err) });
    await appendFileDurable(file, `${line}\n`);
    this.log(`dead letter: ${event.event_id || event.type} in ${roomId} → ${file}`);
  }
}
