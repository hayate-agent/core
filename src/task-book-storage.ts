import { createHash } from "node:crypto";
import { mkdir, open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { syncDirStrict, writeFileDurableExclusive } from "./durable.js";
import type { TaskBook } from "./task-lifecycle.js";

/** Immutable task-book pages are published before the ledger root. The root is
 * the only commit point; orphaned pages after a crash never become authority. */
export class TaskBookStorage {
  private readonly dir: string;
  private readonly known = new Set<string>();
  constructor(ledger: string) { this.dir = `${ledger}.task-book`; }
  private hash(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
  private async directory(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const s = await lstat(this.dir);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 ||
        typeof process.getuid === "function" && s.uid !== process.getuid()) throw Error("Unsafe task book directory");
    await syncDirStrict(path.dirname(this.dir));
  }
  private async read(hash: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid task book page reference");
    const h = await open(path.join(this.dir, `${hash}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await h.stat();
      if (!s.isFile() || s.size > 64 * 1024 * 1024 || (s.mode & 0o077) !== 0 ||
          typeof process.getuid === "function" && s.uid !== process.getuid()) throw Error("Unsafe task book page");
      const raw = await h.readFile("utf8");
      if (this.hash(raw) !== hash) throw Error("Task book page checksum mismatch");
      return raw;
    } finally { await h.close(); }
  }
  private async put(value: unknown): Promise<string> {
    const raw = JSON.stringify(value), hash = this.hash(raw);
    if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw Error("Task book page exceeds reader budget");
    if (this.known.has(hash)) { if (await this.read(hash) !== raw) throw Error("Task book page changed"); return hash; }
    try { await writeFileDurableExclusive(path.join(this.dir, `${hash}.json`), raw); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || await this.read(hash) !== raw) throw e; }
    this.known.add(hash); return hash;
  }
  async stage(book: TaskBook): Promise<{ version: 1; root: string }> {
    await this.directory();
    const tasks: string[] = [], bindings: string[] = [];
    // Small pages avoid rewriting the full history when a task changes.
    for (let i = 0; i < book.tasks.length; i += 64) tasks.push(await this.put({ kind: "tasks", items: book.tasks.slice(i, i + 64) }));
    for (let i = 0; i < book.bindings.length; i += 256) bindings.push(await this.put({ kind: "bindings", items: book.bindings.slice(i, i + 256) }));
    const root = await this.put({ version: 1, tasks, bindings });
    await syncDirStrict(this.dir);
    return { version: 1, root };
  }
  async hydrate(ref: unknown): Promise<TaskBook> {
    const r = ref as { version?: unknown; root?: unknown };
    if (!r || r.version !== 1 || typeof r.root !== "string" || Object.keys(r).some(k => k !== "version" && k !== "root")) throw Error("Invalid task book root");
    await this.directory();
    const root = JSON.parse(await this.read(r.root));
    if (root.version !== 1 || !Array.isArray(root.tasks) || !Array.isArray(root.bindings)) throw Error("Invalid task book manifest");
    const book: TaskBook = { tasks: [], bindings: [] };
    for (const kind of ["tasks", "bindings"] as const) for (const hash of root[kind]) {
      const page = JSON.parse(await this.read(hash));
      if (page.kind !== kind || !Array.isArray(page.items) || page.items.length > (kind === "tasks" ? 64 : 256)) throw Error("Invalid task book page");
      if (kind === "tasks") book.tasks.push(...page.items); else book.bindings.push(...page.items);
    }
    return book;
  }
}
