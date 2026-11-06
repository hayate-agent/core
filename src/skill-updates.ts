// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { parseSkill } from "./skills.js";
import { writeFileDurable } from "./durable.js";

export interface SkillUpdateSource { url: string; sha256: string }
const LIMIT = 512 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Pinned data-only bundles. No archive extraction, scripts, redirects or imports. */
export class SkillUpdates {
  private active?: string;
  constructor(private readonly home: string, private readonly source: SkillUpdateSource | undefined, private readonly fetcher: typeof fetch = fetch) {
    if (source) {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || !/^[a-f0-9]{64}$/.test(source.sha256)) throw Error("Invalid pinned skill source");
    }
  }
  get roots(): string[] { return this.active ? [this.active] : []; }
  private get base(): string { return path.join(this.home, "skill-updates"); }
  private async directory(): Promise<void> {
    await mkdir(this.base, { recursive: true });
    const stat = await lstat(this.base);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe skill update directory");
  }
  private entries(bytes: Buffer): { name: string; content: string }[] {
    if (bytes.length > LIMIT || !isUtf8(bytes) || digest(bytes) !== this.source?.sha256) throw Error("Skill bundle integrity failed");
    const bundle = JSON.parse(bytes.toString("utf8"));
    if (bundle.version !== 1 || !Array.isArray(bundle.skills) || !bundle.skills.length || bundle.skills.length > 64) throw Error("Invalid skill bundle");
    const names = new Set<string>();
    return bundle.skills.map((entry: { name: string; content: string }) => {
      if (!entry || typeof entry.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name) || names.has(entry.name) || typeof entry.content !== "string" || Buffer.byteLength(entry.content) > 32000) throw Error("Invalid skill entry");
      const skill = parseSkill(entry.content, path.join(entry.name, "SKILL.md"));
      if (!skill || skill.name !== entry.name) throw Error("Invalid skill metadata");
      names.add(entry.name); return { name: entry.name, content: entry.content };
    });
  }
  /** Restart reconstructs only the currently configured pin, never an arbitrary saved path. */
  async restore(): Promise<void> {
    if (!this.source) return;
    await this.directory();
    try {
      const file = path.join(this.base, "active.json");
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 750000) throw Error("Unsafe skill activation record");
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (saved.sha256 !== this.source.sha256) return;
      if (typeof saved.bundle !== "string" || saved.bundle.length > 700000) throw Error("Invalid skill activation record");
      await this.install(Buffer.from(saved.bundle, "base64"), async () => {});
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async apply(activate: () => Promise<void>): Promise<void> {
    if (!this.source) throw Error("No infrastructure-pinned skill source configured");
    const response = await this.fetcher(this.source.url, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.body) throw Error("Skill bundle download failed");
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > LIMIT) throw Error("Skill bundle too large"); chunks.push(Buffer.from(value)); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    await this.install(Buffer.concat(chunks), activate);
  }
  private async install(bytes: Buffer, activate: () => Promise<void>): Promise<void> {
    const entries = this.entries(bytes); await this.directory();
    const candidate = path.join(this.base, `bundle-${randomUUID()}`); const old = this.active;
    await mkdir(candidate);
    try {
      for (const entry of entries) { const dir = path.join(candidate, entry.name); await mkdir(dir); await writeFile(path.join(dir, "SKILL.md"), entry.content, { flag: "wx" }); }
      this.active = candidate;
      try {
        await activate();
        await writeFileDurable(path.join(this.base, "active.json"), JSON.stringify({ sha256: this.source!.sha256, bundle: bytes.toString("base64") }));
      } catch (error) { this.active = old; await activate(); throw error; }
    } catch (error) { await rm(candidate, { recursive: true, force: true }); throw error; }
    // Keep prior paths: an active turn may still reference its SKILL.md.
  }
}
