import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
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
  /** Resolve only host-linked predecessors in this conversation. No transcript
   * path, archive ID or claimed user role can grant authority. */
  async completionEvidence(key: string, sessionId: string): Promise<{ entries: ArchiveEntry[]; incomplete: boolean }> {
    const dir = path.join(this.home, "session-archives", createHash("sha256").update(key).digest("hex"));
    let files: string[];
    try { files = await readdir(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], incomplete: false }; throw error; }
    const names = files.filter(file => /^[a-f0-9-]{36}\.json$/.test(file));
    let incomplete = names.length > 64;
    const archives: SessionArchive[] = [];
    for (const name of names.slice(-64)) {
      try { archives.push(await this.load(key, name.slice(0, -5))); }
      catch { incomplete = true; }
    }
    const entries: ArchiveEntry[] = [];
    const visited = new Set<string>();
    let target = sessionId;
    for (let depth = 0; depth < 4; depth++) {
      const matches = archives.filter(archive => archive.targetSessionId === target);
      if (!matches.length) break;
      if (matches.length !== 1 || visited.has(matches[0].id)) { incomplete = true; break; }
      const archive = matches[0]; visited.add(archive.id);
      // Summaries and archived roles are explicitly untrusted context.
      entries.unshift({ id: `${archive.id}:summary`, role: "archive-summary", text: archive.retrospective },
        ...archive.entries.slice(-48).map(entry => ({ ...entry, id: `${archive.id}:${entry.id}`, role: `archive-${entry.role}` })));
      if (archive.entries.length > 48) incomplete = true;
      target = archive.sourceSessionId;
      if (depth === 3 && archives.some(item => item.targetSessionId === target)) incomplete = true;
    }
    return { entries, incomplete };
  }
  async read(key: string, id: string, options: { query?: string; offset?: number; limit?: number; section?: string; charOffset?: number }): Promise<string> {
    const archive = await this.load(key, id);
    const offset = options.offset ?? 0; const limit = options.limit ?? 10; const charOffset = options.charOffset ?? 0;
    if (!Number.isInteger(charOffset) || charOffset < 0 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30 || (options.query?.length ?? 0) > 500) throw new Error("Invalid archive read bounds");
    if (options.section === "summary") return JSON.stringify({
      id, sourceSessionId: archive.sourceSessionId, targetSessionId: archive.targetSessionId,
      retrospective: archive.retrospective.slice(charOffset, charOffset + 1500),
      forward: archive.forward.slice(charOffset, charOffset + 1500),
      charOffset,
      retrospectiveTotalChars: archive.retrospective.length,
      forwardTotalChars: archive.forward.length,
      retrospectiveTruncated: archive.retrospective.length > charOffset + 1500,
      forwardTruncated: archive.forward.length > charOffset + 1500,
    });
    const entries = options.query ? archive.entries.filter((e: ArchiveEntry) => e.text.toLowerCase().includes(options.query!.toLowerCase())) : archive.entries;
    return JSON.stringify({ id, sourceSessionId: archive.sourceSessionId, total: entries.length, offset, entries: entries.slice(offset, offset + limit).map((e: ArchiveEntry) => ({ ...e, text: e.text.slice(charOffset, charOffset + 1500), charOffset, totalChars: e.text.length, truncated: e.text.length > charOffset + 1500 })) });
  }
}
