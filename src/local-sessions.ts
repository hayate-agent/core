import type { SessionProvider } from "./sessions.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { SessionLock } from "./session-lock.js";
import path from "node:path";
import { writeFileDurable } from "./durable.js";

export interface LocalSession {
  id: string;
  key: string;
  workspace: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
}

/** Harness-owned interactive conversations. Never discover PI's global session store. */
export class LocalSessions {
  private constructor(private readonly home: string, readonly workspace: string) {}
  private active?: LocalSession;
  provider?: SessionProvider;
  private readonly locks = new Map<string, SessionLock>();

  static async open(home: string, cwd: string): Promise<LocalSessions> {
    const store = new LocalSessions(home, await realpath(cwd));
    await mkdir(store.directory, { recursive: true, mode: 0o700 });
    return store;
  }

  private get directory(): string { return path.join(this.home, "local-sessions"); }
  private get prefix(): string { return `local-${createHash("sha256").update(this.workspace).digest("hex").slice(0, 24)}-`; }
  get current(): LocalSession | undefined { return this.active; }

  async list(): Promise<LocalSession[]> {
    const rows: LocalSession[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.startsWith(this.prefix) || !name.endsWith(".json")) continue;
      const row = JSON.parse(await readFile(path.join(this.directory, name), "utf8")) as LocalSession;
      if (row.workspace !== this.workspace || row.key !== this.prefix + row.id || !/^[0-9a-f-]{36}$/.test(row.id)) throw new Error("Invalid local session metadata");
      if (this.provider) {
        const id = await this.provider.active(row.key);
        if (id) {
          const record = await this.provider.load(id);
          if (row.title === "Untitled" && record.title !== "New conversation") row.title = record.title;
          row.updatedAt = record.updated;
        }
      }
      if (row.title === "Untitled") {
        const first = (await this.history(row)).find((line) => line.startsWith("You: "));
        if (first) row.title = first.slice(5).replace(/\s+/g, " ").slice(0, 90);
      }
      rows.push(row);
    }
    return rows.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
  }

  async create(title = "Untitled"): Promise<LocalSession> {
    const id = randomUUID();
    const row: LocalSession = { id, key: this.prefix + id, workspace: this.workspace, title, createdAt: new Date().toISOString() };
    const file = await open(path.join(this.directory, `${row.key}.json`), "wx", 0o600);
    try { await file.writeFile(JSON.stringify(row)); await file.sync(); } finally { await file.close(); }
    await this.activate(row);
    return row;
  }

  async rename(title: string): Promise<void> {
    if (!this.active || !title.trim()) throw new Error("Usage: /title <name>");
    const row = { ...this.active, title: title.trim() };
    await writeFileDurable(path.join(this.directory, `${row.key}.json`), JSON.stringify(row));
    this.active = row;
  }

  async resume(id: string): Promise<LocalSession> {
    const matches = (await this.list()).filter((s) => s.id === id);
    if (matches.length !== 1) throw new Error("Session not found in this workspace; use /sessions");
    await this.activate(matches[0]!);
    return matches[0]!;
  }

  /** state.json is a single-writer ledger; do not allow concurrent processes to overwrite it. */
  async acquireHome(): Promise<void> {
    await this.acquireLock(path.join(this.directory, "home.lock"));
  }

  private async activate(row: LocalSession): Promise<void> {
    if (this.active?.id === row.id) return;
    await this.acquireLock(path.join(this.directory, `${row.key}.lock`));
    this.active = row;
  }

  private async acquireLock(lock: string): Promise<void> {
    if (this.locks.has(lock)) return;
    // Keep ownership until shutdown: background jobs may outlive the visible session.
    this.locks.set(lock, await SessionLock.acquire(lock));
  }

  async release(): Promise<void> {
    for (const [file, lock] of this.locks) { await lock.release(); this.locks.delete(file); }
    this.active = undefined;
  }

  /** Reconstruct the current runtime branch, not abandoned branches or tool/system messages. */
  async history(row: LocalSession): Promise<string[]> {
    if (row.workspace !== this.workspace || row.key !== this.prefix + row.id) throw new Error("Wrong workspace");
    if (this.provider) {
      const id = await this.provider.active(row.key);
      if (id) return this.historyLines((await this.provider.load(id)).entries as Array<any>);
    }
    const directory = path.join(this.home, "sessions", row.key);
    let files: string[];
    try { files = (await readdir(directory)).filter((f) => f.endsWith(".jsonl")).sort(); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
    if (!files.length) return [];
    const entries = (await readFile(path.join(directory, files.at(-1)!), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return this.historyLines(entries);
  }

  private historyLines(entries: Array<any>): string[] {
    const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
    const lines: string[] = [];
    let entry = entries.at(-1);
    const seen = new Set<string>();
    while (entry) {
      if (seen.has(entry.id)) throw new Error("Cyclic session history");
      seen.add(entry.id);
      const msg = entry.message;
      if (msg && ["user", "assistant"].includes(msg.role)) {
        const text = typeof msg.content === "string" ? msg.content : (msg.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
        if (text) lines.push(`${msg.role === "user" ? "You" : "Agent"}: ${text}`);
      }
      entry = entry.parentId ? byId.get(entry.parentId) : undefined;
    }
    return lines.reverse();
  }
}
