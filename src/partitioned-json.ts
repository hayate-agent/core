import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { mkdirDurable, writeFileDurable, writeFileDurableExclusive, syncDirStrict } from "./durable.js";
import { readRegular } from "./session-state-storage.js";

interface Reference { hash: string; key?: string; id?: string; sessionKey?: string; parent?: string; status?: string }
interface Index {
  format: "hayate-partitioned-json";
  version: 1;
  document: Record<string, unknown>;
  collections: Record<string, Reference[]>;
}
const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex");
const encode = (value: unknown) => `${JSON.stringify(value)}\n`;

/** One writer, under the host home lock and its owning store's transaction queue.
 * Immutable content-addressed payloads are fsynced BEFORE publishing one atomic
 * reference index. Orphans and prior generations are evidence, never authorities.
 * No directory scan, pruning, fallback to stale legacy data or effect replay.
 * Arrays retain exact order/presence. Loading and hashing are still eager.
 */
export class PartitionedJson {
  private previous?: string;
  private legacy?: string;
  private legacySuffix = "v1";
  private known = new Set<string>();
  private durable = new Map<string, string>();
  private fenced = false;
  private initialized = false;
  constructor(readonly file: string, private readonly arrays: Readonly<Record<string, number>>,
    private readonly write: typeof writeFileDurable = writeFileDurable) {}

  private blob(hash: string): string { return path.join(`${this.file}.parts`, `${hash}.json`); }
  private async identity(hash: string): Promise<string> {
    const info = await lstat(this.blob(hash));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 ||
        typeof process.getuid === "function" && info.uid !== process.getuid()) throw Error("Unsafe partition file");
    return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.uid]);
  }

  private async validateDirectory(): Promise<void> {
    const info = await lstat(`${this.file}.parts`);
    if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid === "function" && info.uid !== process.getuid())
      throw Error("Unsafe partition directory");
  }

  async load(): Promise<Record<string, unknown> | undefined> {
    let raw: string;
    try { raw = await readRegular(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.initialized = true; return undefined; } throw error; }
    const parsed = JSON.parse(raw);
    if (parsed.format !== "hayate-partitioned-json") {
      this.legacy = raw;
      this.legacySuffix = parsed.version === 2 ? "v2" : "v1";
      this.initialized = true;
      return parsed;
    }
    try { await this.validateDirectory(); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      throw new Error("Missing partition directory", { cause });
    }
    if (parsed.version !== 1 || !parsed.document || typeof parsed.document !== "object" || Array.isArray(parsed.document) ||
        !parsed.collections || typeof parsed.collections !== "object" || Array.isArray(parsed.collections)) throw Error("Invalid partition index");
    const index = parsed as Index;
    const document = { ...index.document };
    const known = new Set<string>();
    for (const [name, refs] of Object.entries(index.collections)) {
      if (!Object.hasOwn(this.arrays, name) || Object.hasOwn(document, name) || !Array.isArray(refs)) throw Error("Invalid partition collection");
      const values: unknown[] = [];
      for (const ref of refs) {
        if (!ref || !/^[a-f0-9]{64}$/.test(ref.hash)) throw Error("Invalid partition reference");
        let content: string;
        try { content = await readRegular(this.blob(ref.hash), true); }
        catch (cause) { throw new Error(`Missing/unreadable partition ${ref.hash}`, { cause }); }
        if (hashOf(content) !== ref.hash) throw Error(`Partition checksum mismatch ${ref.hash}`);
        const value = JSON.parse(content);
        if (this.arrays[name]! > 1) {
          if (!Array.isArray(value) || value.length > this.arrays[name]!) throw Error("Invalid partition chunk");
          values.push(...value);
        } else values.push(value);
        known.add(ref.hash);
      }
      document[name] = values;
    }
    // Only adopt a fully verified generation. A missing shard must never look
    // like a missing ledger and silently start empty.
    this.previous = raw;
    if (document.version === 1) {
      this.legacy = raw;
      this.legacySuffix = "partition-v1";
    }
    this.known = known;
    this.initialized = true;
    return document;
  }

  assertWritable(): void {
    if (this.fenced) throw Error("Partition publication uncertain; restart required");
  }

  /** Byte-exact migration evidence must precede staging dependency or row shards. */
  async preserveLegacy(): Promise<void> {
    this.assertWritable();
    if (!this.initialized) await this.load();
    if (this.legacy === undefined) return;
    const backup = `${this.file}.legacy-${this.legacySuffix}`;
    try { await writeFileDurableExclusive(backup, this.legacy, undefined, syncDirStrict); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readRegular(backup, true, true) !== this.legacy) throw error;
      await syncDirStrict(path.dirname(backup));
    }
  }

  async save(document: Record<string, unknown>, publishUnchanged = false): Promise<void> {
    this.assertWritable();
    // Build synchronously before any await: capture live state once, not mutable
    // references that can change while payload writes are in flight.
    const header = { ...document };
    const collections: Record<string, Reference[]> = {};
    const payloads = new Map<string, string>();
    for (const [name, chunk] of Object.entries(this.arrays)) {
      const values = header[name];
      delete header[name];
      if (values === undefined) continue;
      if (!Array.isArray(values)) throw Error(`Invalid partition array ${name}`);
      const refs: Reference[] = [];
      for (let i = 0; i < values.length; i += chunk) {
        const value = chunk === 1 ? values[i] : values.slice(i, i + chunk);
        const raw = encode(value), hash = hashOf(raw);
        const ref: Reference = { hash };
        if (chunk === 1 && value && typeof value === "object") {
          for (const key of ["key", "id", "sessionKey", "parent", "status"] as const) {
            if (typeof value[key] === "string") ref[key] = value[key];
          }
        }
        refs.push(ref);
        payloads.set(hash, raw);
      }
      collections[name] = refs;
    }
    const index = encode({ format: "hayate-partitioned-json", version: 1, document: header, collections } satisfies Index);
    if (!this.initialized) await this.load();
    if (index === this.previous && !publishUnchanged) return;
    try { await lstat(path.dirname(this.file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdirDurable(path.dirname(this.file));
    }
    try { await this.validateDirectory(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdirDurable(`${this.file}.parts`);
      await this.validateDirectory();
    }
    for (const [hash, raw] of payloads) {
      if (this.known.has(hash)) {
        try {
          const identity = await this.identity(hash);
          if (this.durable.get(hash) !== identity) {
            if (await readRegular(this.blob(hash), true, true) !== raw) throw Error("Existing partition checksum mismatch");
            await syncDirStrict(`${this.file}.parts`);
            this.durable.set(hash, await this.identity(hash));
          }
          continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (this.write !== writeFileDurable) { await this.write(this.blob(hash), raw); continue; }
      try { await writeFileDurableExclusive(this.blob(hash), raw, undefined, syncDirStrict); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Re-establish durability after a possible prior link/fsync failure.
        if (await readRegular(this.blob(hash), true, true) !== raw) throw Error("Existing partition checksum mismatch");
        await syncDirStrict(`${this.file}.parts`);
      }
      this.durable.set(hash, await this.identity(hash));
    }
    await this.preserveLegacy();
    let published = false;
    try { await this.write(this.file, index, 0o600, undefined, syncDirStrict, () => { published = true; }); }
    catch (error) {
      // rename may have committed even if directory fsync subsequently failed.
      // Never let a stale in-memory generation overwrite that uncertain commit.
      if (published) this.fenced = true;
      if (this.write !== writeFileDurable) {
        let current: string | undefined;
        try { current = await readRegular(this.file); }
        catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") this.fenced = true; }
        if (current !== (this.previous ?? this.legacy)) this.fenced = true;
      }
      throw error;
    }
    this.previous = index;
    this.legacy = undefined;
    this.known = new Set(Object.values(collections).flatMap(refs => refs.map(ref => ref.hash)));
  }
}
