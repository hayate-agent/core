import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";
import { parseSkill, type SkillInfo } from "./skills.js";

export interface SkillEntry extends SkillInfo {
  contentHash: string;
}

export interface SkillDiagnostic {
  filePath: string;
  message: string;
}

export interface SkillSnapshot {
  schemaVersion: 1;
  generation: number;
  roots: string[];
  entries: SkillEntry[];
  diagnostics: SkillDiagnostic[];
}

const hash = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const missing = (err: unknown) => ["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "");

/** One owner per Harness home. The index is a derived cache, never a source of trusted paths. */
export class SkillCatalog {
  private snapshot?: SkillSnapshot;
  private pending: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private savedSignature?: string;

  constructor(private readonly indexFile: string, private readonly directories: () => string[]) {}

  get skills(): SkillInfo[] {
    return (this.snapshot?.entries ?? []).map(({ contentHash: _, ...skill }) => ({ ...skill }));
  }

  /** Serialized reconciliation; always reads sources, so same-size/same-mtime edits are detected. */
  refresh(): Promise<SkillSnapshot> {
    const next = this.pending.catch(() => undefined).then(() => this.reconcile());
    this.pending = next;
    return next;
  }

  private async reconcile(): Promise<SkillSnapshot> {
    if (!this.initialized) {
      // Only reuse the generation. All metadata and paths are rebuilt from allowed roots.
      try {
        const saved = JSON.parse(await readFile(this.indexFile, "utf8"));
        if (saved?.schemaVersion === 1 && Number.isSafeInteger(saved.generation) && saved.generation >= 0) {
          this.snapshot = { schemaVersion: 1, generation: saved.generation, roots: [], entries: [], diagnostics: [] };
          this.savedSignature = JSON.stringify([saved.roots, saved.entries]);
        }
      } catch { /* Missing or corrupt cache: rebuild from sources. */ }
      this.initialized = true;
    }

    const roots = [...new Set(this.directories().map((dir) => path.resolve(dir)))];
    const diagnostics: SkillDiagnostic[] = [];
    const byName = new Map<string, SkillEntry>();
    const seenFiles = new Set<string>();
    for (const root of roots) {
      let canonicalRoot: string;
      try { canonicalRoot = await realpath(root); }
      catch (err) {
        if (!missing(err)) diagnostics.push({ filePath: root, message: "Cannot access skill directory" });
        continue;
      }
      const files: string[] = [];
      const visited = new Set<string>();
      const walk = async (dir: string, depth: number): Promise<void> => {
        let canonical: string;
        try { canonical = await realpath(dir); }
        catch { diagnostics.push({ filePath: dir, message: "Cannot resolve skill path" }); return; }
        if (!inside(canonicalRoot, canonical)) {
          diagnostics.push({ filePath: dir, message: "Path escapes allowed skill directory" });
          return;
        }
        if (visited.has(canonical)) return;
        visited.add(canonical);
        try {
          const entries = await readdir(canonical, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            const file = path.join(canonical, entry.name);
            if (entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink())) files.push(file);
            else if (depth > 0 && !entry.name.startsWith(".") && entry.name !== "node_modules" && (entry.isDirectory() || entry.isSymbolicLink())) {
              await walk(file, depth - 1);
            }
          }
        } catch { diagnostics.push({ filePath: dir, message: "Cannot read skill directory" }); }
      };
      await walk(canonicalRoot, 3);
      for (const file of files.sort()) {
        try {
          const canonical = await realpath(file);
          if (!inside(canonicalRoot, canonical)) {
            diagnostics.push({ filePath: file, message: "Path escapes allowed skill directory" });
            continue;
          }
          if (seenFiles.has(canonical)) continue;
          seenFiles.add(canonical);
          const content = await readFile(canonical, "utf8");
          const skill = parseSkill(content, canonical);
          if (!skill || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64 || skill.description.length > 1024) {
            diagnostics.push({ filePath: file, message: "Invalid skill frontmatter, name or description" });
            continue;
          }
          if (byName.has(skill.name)) {
            diagnostics.push({ filePath: file, message: `Duplicate skill name: ${skill.name} (first directory wins)` });
            continue;
          }
          byName.set(skill.name, { ...skill, contentHash: hash(content) });
        } catch { diagnostics.push({ filePath: file, message: "Cannot read skill file" }); }
      }
    }
    const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    const previous = this.snapshot;
    const signature = JSON.stringify([roots, entries]);
    const changed = !previous || signature !== (this.savedSignature ?? JSON.stringify([previous.roots, previous.entries]));
    const snapshot: SkillSnapshot = {
      schemaVersion: 1,
      generation: (previous?.generation ?? 0) + (changed ? 1 : 0),
      roots, entries, diagnostics,
    };
    if (JSON.stringify(snapshot) !== JSON.stringify(previous)) {
      await mkdir(path.dirname(this.indexFile), { recursive: true });
      await writeFileDurable(this.indexFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    this.snapshot = snapshot;
    this.savedSignature = undefined;
    return structuredClone(snapshot);
  }
}
