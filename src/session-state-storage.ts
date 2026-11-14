import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { writeFileDurableExclusive, syncDir } from "./durable.js";
import { isDeepStrictEqual } from "node:util";
import type { PersistedSession, PersistedState } from "./state.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
interface Shard {
  version: 1;
  key: string;
  session?: PersistedSession;
  activeTaskId?: string;
  pending?: PersistedState["pending"];
  outbox?: PersistedState["outbox"];
  subagents?: PersistedState["subagents"];
}
export interface StateManifest {
  version: 2;
  globals: Omit<PersistedState, "version" | "sessions" | "pending" | "outbox" | "subagents">;
  refs: Array<{ scope: string; revision: string }>;
  sessionOrder: string[];
  arrays: Array<"pending" | "outbox" | "subagents">;
  orders: Partial<Record<"pending" | "outbox" | "subagents", string[]>>;
}
export interface PreparedState { manifest: StateManifest; shards: Map<string, string> }

/** Encode synchronously at the host capture boundary, before any I/O yields.
 * Task authority, inbox and outbox for a conversation share one immutable shard.
 * No model transcript is moved or rewritten. */
export function prepareSessionState(state: PersistedState, known: (relative: string) => boolean = () => false): PreparedState {
  const { version, sessions, pending, outbox, subagents, ...globals } = state;
  if (version !== 1 || !Array.isArray(sessions)) throw Error("Invalid host state");
  const buckets = new Map<string, Shard>();
  const bucket = (key: string) => {
    if (typeof key !== "string" || !key) throw Error("Missing session state identity");
    if (!buckets.has(key)) buckets.set(key, { version: 1, key });
    return buckets.get(key)!;
  };
  const sessionOrder: string[] = [];
  for (const session of sessions) {
    const row = bucket(session.key);
    if (row.session) throw Error("Duplicate session state identity");
    // A current-task alias is not another copy of its full authority/evidence.
    const { task, ...rest } = session;
    const tasks = session.tasks;
    if (task && tasks?.filter(item => item.id === task.id).length === 1 && tasks.some(item => item.id === task.id && isDeepStrictEqual(item, task)))
      { row.session = { ...rest, tasks }; row.activeTaskId = task.id; }
    else row.session = session; // preserve inconsistent legacy data verbatim, never silently discard it
    sessionOrder.push(digest(session.key));
  }
  for (const input of pending ?? []) (bucket(input.sessionKey).pending ??= []).push(input);
  for (const entry of outbox ?? []) (bucket(entry.sessionKey).outbox ??= []).push(entry);
  for (const record of subagents ?? []) (bucket(record.parent).subagents ??= []).push(record);
  const refs: StateManifest["refs"] = [];
  const shards = new Map<string, string>();
  for (const [key, shard] of buckets) {
    const raw = JSON.stringify(shard) + "\n", scope = digest(key), revision = digest(raw);
    const relative = `${scope}/${revision}.json`;
    refs.push({ scope, revision });
    if (!known(relative)) shards.set(relative, raw);
  }
  const arrays: StateManifest["arrays"] = [];
  if (pending !== undefined) arrays.push("pending");
  if (outbox !== undefined) arrays.push("outbox");
  if (subagents !== undefined) arrays.push("subagents");
  const orders: StateManifest["orders"] = {};
  if (pending) orders.pending = pending.map(input => digest(input.sessionKey));
  if (outbox) orders.outbox = outbox.map(entry => digest(entry.sessionKey));
  if (subagents) orders.subagents = subagents.map(record => digest(record.parent));
  return { manifest: { version: 2, globals: JSON.parse(JSON.stringify(globals)), refs, sessionOrder, arrays, orders }, shards };
}

export async function readRegular(file: string, privateFile = false, durable = false): Promise<string> {
  const handle = await open(file, (durable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || privateFile && ((stat.mode & 0o777) !== 0o600 || typeof process.getuid === "function" && stat.uid !== process.getuid())) throw Error("Session state is not a private regular file");
    const raw = await handle.readFile("utf8");
    if (durable) { await handle.sync(); await syncDir(path.dirname(file)); }
    return raw;
  } finally { await handle.close(); }
}
async function directory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw Error("Unsafe session state directory");
  // A durable child file alone does not persist its newly created parent entry.
  await syncDir(path.dirname(dir));
}
async function parallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  // Bounded independent shard I/O; a session never rewrites another session's payload.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(4, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; await work(items[index]!); }
  }));
  const failed = settled.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/** Immutable per-session revisions plus ONE small atomic publication manifest.
 * The manifest is a transaction commit fence, not a central session payload.
 * A crash before publication leaves the previous complete checkpoint authoritative. */
export class SessionStateStorage {
  private known = new Set<string>();
  constructor(readonly directory: string) {}
  has(relative: string): boolean { return this.known.has(relative); }
  async stage(prepared: PreparedState): Promise<void> {
    await directory(this.directory);
    await parallel([...prepared.shards], async ([relative, raw]) => {
      if (this.known.has(relative)) return;
      const file = path.join(this.directory, relative);
      await directory(path.dirname(file));
      try { await writeFileDurableExclusive(file, raw); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readRegular(file, true, true) !== raw) throw error;
      }
      this.known.add(relative);
    });
  }
  async load(value: unknown): Promise<PersistedState> {
    const manifest = value as StateManifest;
    if (manifest?.version !== 2 || !manifest.globals || typeof manifest.globals !== "object" ||
        !Array.isArray(manifest.refs) || !Array.isArray(manifest.sessionOrder) || !Array.isArray(manifest.arrays) || !manifest.orders ||
        manifest.arrays.some(key => !["pending", "outbox", "subagents"].includes(key))) throw Error("Invalid session state manifest");
    const rows = new Map<string, Shard>();
    await parallel(manifest.refs, async ref => {
      if (!validHash(ref?.scope) || !validHash(ref?.revision)) throw Error("Invalid session state reference");
      const relative = `${ref.scope}/${ref.revision}.json`;
      const raw = await readRegular(path.join(this.directory, relative));
      if (digest(raw) !== ref.revision) throw Error("Session state checksum mismatch");
      const shard = JSON.parse(raw) as Shard;
      if (shard.version !== 1 || typeof shard.key !== "string" || digest(shard.key) !== ref.scope ||
          shard.session && shard.session.key !== shard.key ||
          shard.pending?.some(input => input.sessionKey !== shard.key) ||
          shard.outbox?.some(entry => entry.sessionKey !== shard.key) ||
          shard.subagents?.some(record => record.parent !== shard.key)) throw Error("Session state scope mismatch");
      rows.set(ref.scope, shard); this.known.add(relative);
    });
    if (rows.size !== manifest.refs.length || new Set(manifest.sessionOrder).size !== manifest.sessionOrder.length ||
        manifest.sessionOrder.some(scope => !validHash(scope) || !rows.get(scope)?.session) ||
        [...rows].some(([scope, row]) => row.session && !manifest.sessionOrder.includes(scope))) throw Error("Invalid session state membership");
    const sessions = manifest.sessionOrder.map(scope => {
      const row = rows.get(scope)!, session = row.session!;
      if (row.activeTaskId !== undefined) {
        const task = session.tasks?.find(task => task.id === row.activeTaskId);
        if (!task || session.task || session.tasks!.filter(item => item.id === row.activeTaskId).length !== 1) throw Error("Missing or conflicting active task reference");
        session.task = task;
      }
      return session;
    });
    if (new Set(manifest.arrays).size !== manifest.arrays.length) throw Error("Duplicate session array declaration");
    for (const key of ["pending", "outbox", "subagents"] as const)
      if (!manifest.arrays.includes(key) && [...rows.values()].some(row => row[key] !== undefined)) throw Error("Omitted committed session array");
    const state: PersistedState = { ...manifest.globals, version: 1, sessions };
    for (const key of manifest.arrays) {
      const order = manifest.orders[key];
      if (!Array.isArray(order)) throw Error("Missing session array order");
      const cursors = new Map<string, number>();
      const ordered = order.map(scope => {
        if (!validHash(scope)) throw Error("Invalid session array scope");
        const index = cursors.get(scope) ?? 0, item = rows.get(scope)?.[key]?.[index];
        if (!item) throw Error("Missing session array entry");
        cursors.set(scope, index + 1); return item;
      });
      if ([...rows].some(([scope, row]) => (row[key]?.length ?? 0) !== (cursors.get(scope) ?? 0))) throw Error("Unreferenced session array entry");
      (state as any)[key] = ordered;
    }
    return state;
  }
  /** Only obsolete committed revisions are eligible. Never remove authority from
   * the current manifest, uncommitted transactions, legacy backup or transcripts. */
  async retire(current: StateManifest): Promise<void> {
    const keep = new Set(current.refs.map(ref => `${ref.scope}/${ref.revision}.json`));
    await parallel([...this.known], async relative => {
      if (keep.has(relative)) return;
      // An unlink failure can itself have an uncertain outcome. A later
      // return to this revision must re-establish existence and durability.
      this.known.delete(relative);
      await unlink(path.join(this.directory, relative)).catch(() => {});
    });
  }
}
