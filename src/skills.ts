import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

/**
 * Runtime-independent skill discovery (SKILL.md with name/description frontmatter).
 * The PI runtime additionally uses PI's own discovery; this catalog feeds /skills,
 * /help and slash invocation of skills (/<skill-name>), and keeps skills usable
 * if the runtime is swapped.
 */
export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseSkill(content: string, filePath: string): SkillInfo | undefined {
  const m = FRONTMATTER.exec(content);
  if (!m) return undefined;
  let fm: Record<string, unknown>;
  try {
    fm = (parse(m[1]) ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const baseDir = path.dirname(filePath);
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : path.basename(baseDir);
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) return undefined;
  return { name, description, filePath, baseDir };
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === "SKILL.md") out.push(p);
    else if ((e.isDirectory() || e.isSymbolicLink()) && depth > 0 && !e.name.startsWith(".") && e.name !== "node_modules") {
      try {
        if ((await stat(p)).isDirectory()) await walk(p, depth - 1, out);
      } catch {
        /* dangling symlink */
      }
    }
  }
}

/** First directory wins on name collisions (pass dirs in priority order). */
export async function discoverSkills(dirs: string[]): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>();
  for (const dir of dirs) {
    const files: string[] = [];
    await walk(dir, 3, files);
    files.sort();
    for (const f of files) {
      const skill = parseSkill(await readFile(f, "utf8"), f);
      if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Prompt that makes the agent load and follow a skill (used for `/<skill-name> args`). */
export function skillInvocationPrompt(skill: SkillInfo, args: string): string {
  return [
    `Use the skill "${skill.name}". Read ${skill.filePath} first and follow it.`,
    `Resolve relative paths in the skill against ${skill.baseDir}.`,
    args.trim() ? `\nTask: ${args.trim()}` : "",
  ].join("\n");
}
