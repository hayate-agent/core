import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";

export interface SessionRecord {
  id: string;
  key: string;
  title: string;
  updated: string;
  revision: number;
  format: string;
  entries: unknown[];
}
export type SessionSummary = Omit<SessionRecord, "entries">;
/** One owner process per provider directory. Database plugins must enforce equivalent revision checks. */
export interface SessionProvider {
  /** Optional host-owned cleanup, after all session checkpoints have drained. */
  close?(): Promise<void>;
  /** Optional host lifecycle pin; implementations normally leave this to the owner. */
  retain?(): { provider: SessionProvider; release(): void };
  load(id: string): Promise<SessionRecord>;
  active(key: string): Promise<string | undefined>;
  bind(key: string, id: string): Promise<void>;
  create(key: string, format: string, entries: unknown[]): Promise<SessionRecord>;
  save(record: SessionRecord, expectedRevision: number): Promise<SessionRecord>;
  list(key: string, offset?: number, limit?: number): Promise<SessionSummary[]>;
}
export type SessionProviderFactory = (context: { home: string; options: unknown }) => Promise<SessionProvider>;

export class FilesystemSessionProvider implements SessionProvider {
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}
  private file(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid session ID");
    return path.join(this.root, `${id}.json`);
  }
  private binding(key: string): string { return path.join(this.root, `binding-${createHash("sha256").update(key).digest("hex")}.json`); }
  async load(id: string): Promise<SessionRecord> { return JSON.parse(await readFile(this.file(id), "utf8")); }
  async active(key: string): Promise<string | undefined> {
    let id: string;
    try { id = JSON.parse(await readFile(this.binding(key), "utf8")).id; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    if ((await this.load(id)).key !== key) throw new Error("Session belongs to a different conversation");
    return id;
  }
  async bind(key: string, id: string): Promise<void> {
    const record = await this.load(id);
    if (record.key !== key) throw new Error("Session belongs to a different conversation");
    await writeFileDurable(this.binding(key), JSON.stringify({ id }));
  }
  async create(key: string, format: string, entries: unknown[]): Promise<SessionRecord> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const record: SessionRecord = { id: randomUUID(), key, title: "New conversation", format, entries, updated: new Date().toISOString(), revision: 0 };
    await writeFileDurable(this.file(record.id), JSON.stringify(record));
    return record;
  }
  save(record: SessionRecord, expectedRevision: number): Promise<SessionRecord> {
    const task = this.writing.catch(() => {}).then(async () => {
      const current = await this.load(record.id);
      if (current.revision !== expectedRevision || current.key !== record.key) throw new Error("Session revision conflict");
      const next = { ...record, revision: expectedRevision + 1, updated: new Date().toISOString() };
      await writeFileDurable(this.file(record.id), JSON.stringify(next));
      return next;
    });
    this.writing = task;
    return task;
  }
  async list(key: string, offset = 0, limit = 20): Promise<SessionSummary[]> {
    let files: string[];
    try { files = await readdir(this.root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const records: SessionSummary[] = [];
    for (const file of files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const { entries: _, ...record } = await this.load(file.slice(0, -5));
      if (record.key === key) records.push(record);
    }
    return records.sort((a, b) => b.updated.localeCompare(a.updated)).slice(offset, offset + Math.min(100, Math.max(1, limit)));
  }
}
