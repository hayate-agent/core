import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, open } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { writeFileDurable } from "./durable.js";
import { memoryConfig, type MemoryConfig, type MemoryContext, type MemoryEntry, type MemoryHit, type MemoryProvider, type MemoryStatus, type MemoryWrite } from "./memory.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const idPattern = /^[a-f0-9]{64}$/;
const words = (s: string) => [...new Set(s.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
function validDate(value: unknown): boolean { return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value))); }
function validate(e: MemoryEntry): void {
  if (!e || !idPattern.test(e.id) || typeof e.sessionKey !== "string" || !e.sessionKey || e.sessionKey.length > 1000 ||
      typeof e.title !== "string" || !e.title.trim() || e.title.length > 300 || typeof e.text !== "string" || !e.text.trim() || e.text.length > 12000 ||
      !["note", "lesson", "decision", "operation"].includes(e.kind) || !["reported", "observed"].includes(e.verification) ||
      !["active", "revoked", "archived"].includes(e.state) || typeof e.source !== "string" || e.source.length > 1000 ||
      typeof e.revision !== "string" || !e.revision || !validDate(e.createdAt) || !validDate(e.updatedAt) || !e.createdAt || !e.updatedAt ||
      !validDate(e.expiresAt) || !validDate(e.reviewAfter) || !Array.isArray(e.links) || e.links.length > 20 || e.links.some((x) => typeof x !== "string" || !idPattern.test(x))) throw Error("Invalid memory entry");
}
interface Row { entry: MemoryEntry; contentHash: string; inputHash?: string; vector?: number[]; model?: string }
export class FileMemoryStore implements MemoryProvider {
  readonly capabilities;
  private rows = new Map<string, Row>();
  private indexCost = 64;
  private rowCost(row: Row): number {
    // Reserve vector JSON space before acknowledging a source write, including future embeddings.
    const { vector: _vector, model: _model, ...rest } = row;
    const base = { ...rest, entry: { ...rest.entry, revision: "0".repeat(64) } };
    return Buffer.byteLength(JSON.stringify(base)) + 256 + (this.config.embedding ? (this.config.embedding.dimensions ?? 8192) * 32 : 0);
  }
  private inverted = new Map<string, Set<string>>();
  private config: MemoryConfig;
  private timer?: NodeJS.Timeout;
  private embeddingBusy = false;
  private embeddingBudget = 16;
  private embeddingBudgetAt = Date.now();
  private stopped = false;
  private dirty = false;
  private lastScan?: string;
  private error?: string;
  private semanticError = false;
  private queue = Promise.resolve();
  constructor(private readonly dir: string, config: MemoryConfig) {
    this.config = memoryConfig(config); this.capabilities = { semantic: Boolean(config.embedding), revisions: true };
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(fn); this.queue = next.then(() => {}, () => {}); return next;
  }
  private get entriesDir(): string { return path.join(this.dir, "entries"); }
  async start(): Promise<void> {
    await mkdir(this.entriesDir, { recursive: true, mode: 0o700 });
    try {
      const file = path.join(this.dir, "index.json");
      if ((await lstat(file)).size > this.config.maxIndexBytes) throw Error("Memory snapshot exceeds configured budget");
      const snapshot = JSON.parse(await readFile(file, "utf8"));
      if (snapshot.version !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length > this.config.maxEntries) throw Error("Invalid memory snapshot");
      for (const row of snapshot.rows as Row[]) {
        validate(row.entry);
        if (row.vector && (!Array.isArray(row.vector) || row.vector.length > 8192 || row.vector.some((n) => !Number.isFinite(n)))) throw Error("Invalid vector snapshot");
        this.rows.set(row.entry.id, row);
      }
      this.indexCost = 64 + [...this.rows.values()].reduce((sum, row) => sum + this.rowCost(row), 0);
      if (this.indexCost > this.config.maxIndexBytes) throw Error("Memory index budget exceeded");
      this.rebuildTerms();
    } catch (err) {
      this.rows.clear(); this.inverted.clear(); this.indexCost = 64;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.error = "Snapshot unavailable; rebuilding from Markdown";
    }
    // Serve snapshot immediately. Search/get revalidate source files before returning data.
    this.timer = setInterval(() => { void this.reindex().catch(() => {}); }, this.config.scanSeconds * 1000);
    this.timer.unref();
    void this.reindex().catch(() => {});
  }
  private file(id: string): string { if (!idPattern.test(id)) throw Error("Invalid memory ID"); return path.join(this.entriesDir, `${id}.md`); }
  private async read(id: string): Promise<Row | undefined> {
    const file = this.file(id);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error("Unsafe or oversized memory file");
      const raw = await readFile(file, "utf8");
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
      if (!match) throw Error("Invalid memory Markdown");
      const meta = parse(match[1]);
      const entry = { ...meta, text: match[2].endsWith("\n") ? match[2].slice(0, -1) : match[2] } as MemoryEntry;
      delete (entry as any).inputHash;
      validate(entry);
      if (entry.id !== id) throw Error("Memory ID mismatch");
      entry.revision = hash(raw); // detects manual edits, not just provider-generated revisions
      const old = this.rows.get(id);
      const contentHash = hash(entry.title + "\n" + entry.text);
      return { entry, contentHash, inputHash: meta.inputHash, ...(old?.contentHash === contentHash ? { vector: old.vector, model: old.model } : {}) };
    } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
  }
  private async write(row: Row): Promise<void> {
    validate(row.entry);
    const { text, ...meta } = row.entry;
    const cost = this.indexCost - (this.rows.has(row.entry.id) ? this.rowCost(this.rows.get(row.entry.id)!) : 0) + this.rowCost(row);
    if (cost > this.config.maxIndexBytes) throw Error("Memory index budget exceeded");
    const raw = `---\n${stringify({ ...meta, inputHash: row.inputHash }).trimEnd()}\n---\n${text}\n`;
    await writeFileDurable(this.file(row.entry.id), raw);
    row.entry.revision = hash(raw);
    this.indexCost = cost;
    this.removeTerms(row.entry.id);
    this.rows.set(row.entry.id, row); this.dirty = true; this.addTerms(row.entry.id, row);
    // Start derived indexing after acknowledging durable Markdown; never wait for
    // network access while holding the serialized write queue.
    setImmediate(() => { void this.embedPending(); });
  }
  private removeTerms(id: string): void {
    const old = this.rows.get(id);
    if (old) for (const term of words(old.entry.title + " " + old.entry.text)) {
      const ids = this.inverted.get(term); ids?.delete(id); if (!ids?.size) this.inverted.delete(term);
    }
  }
  private addTerms(id: string, row: Row): void {
    for (const term of words(row.entry.title + " " + row.entry.text)) {
      let ids = this.inverted.get(term); if (!ids) this.inverted.set(term, ids = new Set()); ids.add(id);
    }
  }
  private rebuildTerms(): void { this.inverted.clear(); for (const [id, row] of this.rows) this.addTerms(id, row); }
  private async snapshot(): Promise<void> {
    if (!this.dirty) return;
    const data = JSON.stringify({ version: 1, rows: [...this.rows.values()] });
    if (Buffer.byteLength(data) > this.config.maxIndexBytes) throw Error("Memory index budget exceeded; increase budget or use external provider");
    await writeFileDurable(path.join(this.dir, "index.json"), data); this.dirty = false;
  }
  put(ctx: MemoryContext, input: MemoryWrite): Promise<MemoryEntry> {
    return this.serial(async () => {
      if (!input || typeof input.key !== "string" || !input.key || input.key.length > 500 || !ctx.sessionKey) throw Error("Invalid memory write key");
      const id = hash(ctx.sessionKey + "\0" + input.key);
      const normalized = { title: input.title, text: input.text, kind: input.kind ?? "note", source: input.source, links: input.links ?? [], reviewAfter: input.reviewAfter, expiresAt: input.expiresAt };
      // Retry identity includes validity deadlines; persisted capture jobs retain them.
      const inputHash = hash(JSON.stringify(normalized));
      const existing = await this.read(id);
      if (existing) {
        if (existing.entry.sessionKey !== ctx.sessionKey || existing.inputHash !== inputHash) throw Error("Memory idempotency conflict");
        return existing.entry;
      }
      if (this.rows.size >= this.config.maxEntries) throw Error("Memory entry budget exceeded");
      const now = new Date().toISOString();
      const entry: MemoryEntry = { id, revision: randomUUID(), sessionKey: ctx.sessionKey, title: input.title, text: input.text,
        kind: input.kind ?? "note", verification: "reported", source: input.source, createdAt: now, updatedAt: now,
        ...(input.reviewAfter !== undefined ? { reviewAfter: input.reviewAfter } : {}), ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}), state: "active", links: input.links ?? [] };
      await this.write({ entry, contentHash: hash(entry.title + "\n" + entry.text), inputHash });
      // Markdown is authoritative: snapshot failure cannot uncommit a durable write.
      return entry;
    });
  }
  async get(ctx: MemoryContext, id: string): Promise<MemoryEntry | undefined> {
    const row = await this.read(id);
    return row?.entry.sessionKey === ctx.sessionKey ? row.entry : undefined;
  }
  revise(ctx: MemoryContext, id: string, revision: string, patch: Parameters<MemoryProvider["revise"]>[3]): Promise<MemoryEntry> {
    return this.serial(async () => {
      const row = await this.read(id);
      if (!row || row.entry.sessionKey !== ctx.sessionKey) throw Error("Memory not found");
      if (row.entry.revision !== revision) throw Error("Memory revision conflict");
      if (!patch || Object.keys(patch).some((k) => !["state", "text", "reviewAfter", "expiresAt"].includes(k))) throw Error("Invalid memory patch");
      const entry = { ...row.entry, ...patch, revision: randomUUID(), updatedAt: new Date().toISOString() };
      const contentHash = hash(entry.title + "\n" + entry.text);
      await this.write({ ...row, entry, contentHash, ...(contentHash !== row.contentHash ? { vector: undefined, model: undefined } : {}) });
      return entry;
    });
  }
  forget(ctx: MemoryContext, id: string, revision: string): Promise<void> {
    return this.serial(async () => {
      const entry = await this.get(ctx, id);
      if (!entry) throw Error("Memory not found");
      if (entry.revision !== revision) throw Error("Memory revision conflict");
      await unlink(this.file(id));
      const fh = await open(this.entriesDir, "r"); try { await fh.sync(); } finally { await fh.close(); }
      this.indexCost -= this.rows.has(id) ? this.rowCost(this.rows.get(id)!) : 0;
      this.removeTerms(id); this.rows.delete(id); this.dirty = true;
      await this.snapshot();
    });
  }
  private async embed(text: string): Promise<number[]> {
    const e = this.config.embedding!;
    const token = e.tokenEnv ? process.env[e.tokenEnv] : undefined;
    if (e.tokenEnv && !token) throw Error("Embedding credential unavailable");
    const res = await fetch(e.url, { method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model: e.model, input: text, ...(e.dimensions ? { dimensions: e.dimensions } : {}) }) });
    if (!res.ok) throw Error("Embedding request failed");
    const reader = res.body?.getReader(); if (!reader) throw Error("Empty embedding response");
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 256000) throw Error("Embedding response too large"); chunks.push(next.value); } }
    finally { await reader.cancel(); }
    const vector = JSON.parse(Buffer.concat(chunks).toString()).data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || vector.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n)) || (e.dimensions && vector.length !== e.dimensions)) throw Error("Invalid embedding vector");
    const norm = Math.hypot(...vector); if (!norm) throw Error("Empty embedding vector");
    return vector.map((v: number) => v / norm);
  }
  private modelKey(): string { return hash(JSON.stringify(this.config.embedding)); }
  async search(ctx: MemoryContext, query: string, options: { limit?: number; historical?: boolean } | null = {}): Promise<MemoryHit[]> {
    options ??= {};
    if (typeof query !== "string" || !query.trim() || query.length > 2000 || (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20))) throw Error("Invalid memory search");
    const terms = words(query); const scores = new Map<string, number>();
    for (const term of terms) for (const id of this.inverted.get(term) ?? []) {
      if (this.rows.get(id)?.entry.sessionKey === ctx.sessionKey) scores.set(id, (scores.get(id) ?? 0) + 1 / Math.max(1, terms.length));
    }
    if (this.config.embedding) {
      try {
        const vector = await this.embed(query);
        for (const [id, row] of this.rows) {
          if (row.entry.sessionKey !== ctx.sessionKey || row.model !== this.modelKey() || row.vector?.length !== vector.length) continue;
          const similarity = row.vector.reduce((sum, v, i) => sum + v * vector[i]!, 0);
          if (similarity > 0.2) scores.set(id, (scores.get(id) ?? 0) + similarity);
        }
        this.semanticError = false;
      } catch { this.semanticError = true; }
    }
    const hits: MemoryHit[] = []; const now = Date.now();
    // Revalidate authoritative source, including deletions, revocations and expiry.
    for (const [id, score] of [...scores].sort((a, b) => b[1] - a[1]).slice(0, 200)) {
      let row: Row | undefined;
      try { row = await this.read(id); } catch { continue; }
      if (!row || row.entry.sessionKey !== ctx.sessionKey || (!options.historical && (row.entry.state !== "active" || (row.entry.expiresAt && Date.parse(row.entry.expiresAt) <= now)))) continue;
      hits.push({ entry: row.entry, score, reviewDue: Boolean(row.entry.reviewAfter && Date.parse(row.entry.reviewAfter) <= now) });
      if (hits.length >= (options.limit ?? 5)) break;
    }
    return hits;
  }
  reindex(): Promise<void> {
    return this.serial(async () => {
      const names = (await readdir(this.entriesDir)).filter((n) => /^[a-f0-9]{64}\.md$/.test(n));
      if (names.length > this.config.maxEntries) throw Error("Memory entry budget exceeded");
      const next = new Map<string, Row>(); let bytes = 64; let invalid = 0;
      for (const name of names) {
        try { const row = await this.read(name.slice(0, -3)); if (row) { bytes += this.rowCost(row); if (bytes > this.config.maxIndexBytes) throw Error("budget"); next.set(row.entry.id, row); } }
        catch (err) { if ((err as Error).message === "budget") throw Error("Memory index budget exceeded"); invalid++; }
      }
      const changed = next.size !== this.rows.size || [...next].some(([id, row]) => row.entry.revision !== this.rows.get(id)?.entry.revision);
      this.rows = next; this.indexCost = bytes;
      if (changed) { this.rebuildTerms(); this.dirty = true; }
      await this.snapshot(); this.lastScan = new Date().toISOString(); this.error = invalid ? `${invalid} invalid memory files excluded` : undefined;
      setImmediate(() => { void this.embedPending(); });
    }).catch((err) => { this.error = (err as Error).message; throw err; });
  }
  private async embedPending(): Promise<void> {
    if (this.embeddingBusy || !this.config.embedding || this.stopped) return;
    const now = Date.now();
    if (now - this.embeddingBudgetAt >= this.config.scanSeconds * 1000) {
      this.embeddingBudget = 16;
      this.embeddingBudgetAt = now;
    }
    if (!this.embeddingBudget) return;
    this.embeddingBusy = true;
    let completed = false;
    try {
      // Bounded work per pass, network awaits outside serial write queue.
      for (const [id, row] of [...this.rows].filter(([, r]) => !r.vector || r.model !== this.modelKey()).slice(0, this.embeddingBudget)) {
        if (this.stopped) break;
        // Earlier network awaits allow forget/revise/reindex to supersede captured rows.
        // Check immediately before dispatch; already in-flight requests cannot be recalled.
        const current = this.rows.get(id);
        if (!current || current.contentHash !== row.contentHash) continue;
        if (current.vector && current.model === this.modelKey()) continue;
        this.embeddingBudget--; // failed requests consume budget too
        const vector = await this.embed(row.entry.title + "\n" + row.entry.text);
        await this.serial(async () => {
          const current = this.rows.get(id);
          if (current?.contentHash === row.contentHash) { current.vector = vector; current.model = this.modelKey(); this.dirty = true; }
        });
      }
      this.semanticError = false;
      await this.serial(() => this.snapshot());
      completed = true;
    } catch { this.semanticError = true; }
    finally {
      this.embeddingBusy = false;
      // Continue bounded batches, including writes made during a network await.
      // On failure leave retries to the periodic scan instead of spinning.
      if (completed && this.embeddingBudget > 0 && !this.stopped && [...this.rows.values()].some((r) => !r.vector || r.model !== this.modelKey())) {
        setImmediate(() => { void this.embedPending(); });
      }
    }
  }
  async status(): Promise<MemoryStatus> {
    return { provider: "local", entries: this.rows.size, indexed: this.rows.size, ready: Boolean(this.lastScan || this.rows.size),
      semantic: !this.config.embedding ? "disabled" : this.semanticError || [...this.rows.values()].some((r) => !r.vector || r.model !== this.modelKey()) ? "degraded" : "ready", lastScan: this.lastScan, error: this.error };
  }
  async close(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.serial(() => this.snapshot()); }
}

// Imported by tests without starting an IPC server.
if (process.send) {
  let store: FileMemoryStore | undefined;
  let requests = 0;
  process.on("message", async (message: any) => {
    if (++requests > 64) { requests--; process.send?.({ id: message.id, error: "Memory queue full" }); return; }
    try {
      const allowed = ["put", "get", "search", "revise", "forget", "status", "reindex", "close"] as const;
      let value: unknown;
      if (message.method === "open" && !store) { store = new FileMemoryStore(message.args[0], message.args[1]); await store.start(); }
      else if (store && allowed.includes(message.method)) value = await (store[message.method as typeof allowed[number]] as Function).apply(store, message.args);
      else throw Error("Invalid memory operation");
      process.send?.({ id: message.id, value });
    } catch (err) { process.send?.({ id: message.id, error: (err as Error).message }); }
    finally { requests--; }
  });
  process.on("disconnect", () => process.exit(0));
}
