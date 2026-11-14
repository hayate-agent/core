import { createHash } from "node:crypto";
import { mkdir, open, lstat, readdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { syncDirStrict, writeFileDurableExclusive } from "./durable.js";
import type { TaskBook } from "./task-lifecycle.js";

/** Immutable task-book pages are published before the ledger root. The root is
 * the only commit point; orphaned pages after a crash never become authority. */
export class TaskBookStorage {
  private readonly dir: string;
  private readonly known = new Set<string>();
  private readonly limit = 256 * 1024 * 1024;
  constructor(ledger: string) { this.dir = `${ledger}.task-book`; }
  private hash(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
  private authorizedGroup(gid: number): boolean {
    return typeof process.getgid === "function" &&
      [process.getgid(), ...(typeof process.getgroups === "function" ? process.getgroups() : [])].includes(gid);
  }
  private async validateDirectory(): Promise<void> {
    const s = await lstat(this.dir), mode = s.mode & 0o7777;
    if (!s.isDirectory() || s.isSymbolicLink() ||
        typeof process.getuid === "function" && s.uid !== process.getuid() ||
        !(mode === 0o700 || [0o750, 0o770, 0o2750, 0o2770].includes(mode) && this.authorizedGroup(s.gid)))
      throw Error("Unsafe task book directory");
  }
  private async directory(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.validateDirectory();
    const h = await open(this.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await h.chmod(0o700); await h.sync(); } finally { await h.close(); }
    await syncDirStrict(path.dirname(this.dir));
  }
  private async read(hash: string, durable = false): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid task book page reference");
    const h = await open(path.join(this.dir, `${hash}.json`), (durable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await h.stat();
      const mode = s.mode & 0o7777;
      if (!s.isFile() || s.size > this.limit ||
          !(mode === 0o600 || [0o640, 0o660].includes(mode) && this.authorizedGroup(s.gid)) ||
          typeof process.getuid === "function" && s.uid !== process.getuid()) throw Error("Unsafe task book page");
      const raw = await h.readFile("utf8");
      if (this.hash(raw) !== hash) throw Error("Task book page checksum mismatch");
      if (durable) { await h.chmod(0o600); await h.sync(); await syncDirStrict(this.dir); }
      return raw;
    } finally { await h.close(); }
  }
  private async put(value: unknown): Promise<string> {
    const raw = JSON.stringify(value), hash = this.hash(raw);
    if (Buffer.byteLength(raw) > this.limit) throw Error("Task book page exceeds reader budget");
    if (this.known.has(hash)) { if (await this.read(hash, true) !== raw) throw Error("Task book page changed"); return hash; }
    try { await writeFileDurableExclusive(path.join(this.dir, `${hash}.json`), raw); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || await this.read(hash, true) !== raw) throw e; }
    this.known.add(hash); return hash;
  }
  async stage(book: TaskBook): Promise<{ version: 1; root: string }> {
    await this.directory();
    const tasks: string[] = [], bindings: string[] = [];
    // Stable item-count pages plus a byte budget: a single permitted large task
    // gets its own page, while ordinary small updates only rewrite one page.
    const pages = async (kind: "tasks" | "bindings", items: unknown[], max: number, out: string[]) => {
      let page: unknown[] = [], bytes = 0;
      for (const item of items) {
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (page.length && (page.length >= max || bytes + size > 4 * 1024 * 1024)) {
          out.push(await this.put({ kind, items: page })); page = []; bytes = 0;
        }
        page.push(item); bytes += size;
      }
      if (page.length) out.push(await this.put({ kind, items: page }));
    };
    await pages("tasks", book.tasks, 64, tasks);
    await pages("bindings", book.bindings, 256, bindings);
    const root = await this.put({ version: 1, tasks, bindings });
    await syncDirStrict(this.dir);
    return { version: 1, root };
  }
  /** Offline maintenance only: caller must hold exclusive ownership across all
   * readers and writers, e.g. with the existing process-wide home lock. */
  async collectOffline(ref: { version: 1; root: string }): Promise<number> {
    const manifest = JSON.parse(await this.read(ref.root));
    if (manifest.version !== 1 || !Array.isArray(manifest.tasks) || !Array.isArray(manifest.bindings)) throw Error("Invalid task book manifest");
    const keep = new Set([ref.root, ...manifest.tasks, ...manifest.bindings]); let removed = 0;
    for (const name of await readdir(this.dir)) {
      const match = /^([a-f0-9]{64})\.json$/.exec(name);
      if (match && !keep.has(match[1])) { await unlink(path.join(this.dir, name)); this.known.delete(match[1]); removed++; }
    }
    await syncDirStrict(this.dir); return removed;
  }
  async hydrate(ref: unknown): Promise<TaskBook> {
    try { return await this.hydratePages(ref); }
    catch (cause) { throw new Error("Cannot load retained task book pages", { cause }); }
  }
  private async hydratePages(ref: unknown): Promise<TaskBook> {
    const r = ref as { version?: unknown; root?: unknown };
    if (!r || r.version !== 1 || typeof r.root !== "string" || Object.keys(r).some(k => k !== "version" && k !== "root")) throw Error("Invalid task book root");
    await this.validateDirectory();
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
