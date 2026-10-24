import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";

export interface ArchiveEntry { id: string; role: string; text: string }
export interface SessionArchive {
  version: 1;
  id: string;
  sourceSessionId: string;
  targetSessionId?: string;
  createdAt: string;
  retrospective: string;
  forward: string;
  entries: ArchiveEntry[];
}
/** Archives are scoped by Harness conversation key; model input never becomes a filesystem path. */
export class SessionArchives {
  constructor(private readonly home: string) {}
  private file(key: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid archive ID");
    return path.join(this.home, "session-archives", createHash("sha256").update(key).digest("hex"), `${id}.json`);
  }
  async create(key: string, sourceSessionId: string, retrospective: string, forward: string, entries: ArchiveEntry[]): Promise<SessionArchive> {
    const archive: SessionArchive = { version: 1, id: randomUUID(), sourceSessionId, createdAt: new Date().toISOString(), retrospective, forward, entries };
    await this.save(key, archive);
    return archive;
  }
  private async save(key: string, archive: SessionArchive): Promise<void> {
    const file = this.file(key, archive.id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileDurable(file, `${JSON.stringify(archive)}\n`);
  }
  async load(key: string, id: string): Promise<SessionArchive> {
    const archive = JSON.parse(await readFile(this.file(key, id), "utf8"));
    if (archive.version !== 1 || archive.id !== id || !Array.isArray(archive.entries)) throw new Error("Invalid session archive");
    return archive;
  }
  async link(key: string, id: string, targetSessionId: string): Promise<void> {
    const archive = await this.load(key, id);
    archive.targetSessionId = targetSessionId;
    await this.save(key, archive);
  }
  async read(key: string, id: string, options: { query?: string; offset?: number; limit?: number; section?: string; charOffset?: number }): Promise<string> {
    const archive = await this.load(key, id);
    if (options.section === "summary") return JSON.stringify({ id, sourceSessionId: archive.sourceSessionId, targetSessionId: archive.targetSessionId, retrospective: archive.retrospective, forward: archive.forward }).slice(0, 20000);
    const offset = options.offset ?? 0; const limit = options.limit ?? 10; const charOffset = options.charOffset ?? 0;
    if (!Number.isInteger(charOffset) || charOffset < 0 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30 || (options.query?.length ?? 0) > 500) throw new Error("Invalid archive read bounds");
    const entries = options.query ? archive.entries.filter((e: ArchiveEntry) => e.text.toLowerCase().includes(options.query!.toLowerCase())) : archive.entries;
    return JSON.stringify({ id, sourceSessionId: archive.sourceSessionId, total: entries.length, offset, entries: entries.slice(offset, offset + limit).map((e: ArchiveEntry) => ({ ...e, text: e.text.slice(charOffset, charOffset + 1500), charOffset, totalChars: e.text.length, truncated: e.text.length > charOffset + 1500 })) });
  }
}
