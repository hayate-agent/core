import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";

const resolved = (value: string) => path.resolve(value.replace(/^~(?=$|[/\\])/, os.homedir()));
/** Mirrors native continueRecent's mtime+header/cwd choice without opening a
 * persistent SessionManager (which may repair/migrate files) or parsing every
 * archived conversation just to locate the one active resume candidate. */
export async function retainedSessionFile(directory: string, cwd: string): Promise<{ file: string; id: string } | undefined> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const files = await Promise.all(names.filter(name => name.endsWith(".jsonl")).map(async name => {
    const file = path.join(directory, name); return { file, modified: (await stat(file)).mtimeMs };
  }));
  files.sort((a, b) => b.modified - a.modified);
  for (const candidate of files) {
    const file = await open(candidate.file, "r");
    let pending = "";
    const decoder = new StringDecoder("utf8");
    try {
      const buffer = Buffer.alloc(4096);
      for (let consumed = 0; consumed < 65536;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, 65536 - consumed), consumed);
        consumed += bytesRead; pending += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        if (!bytesRead) lines.push(pending);
        let discovered = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry: { type?: unknown; id?: unknown; cwd?: unknown };
          try { entry = JSON.parse(line); discovered = true; } catch { continue; }
          if (entry?.type === "session" && typeof entry.id === "string" && typeof entry.cwd === "string" && resolved(entry.cwd) === resolved(cwd))
            return { file: candidate.file, id: entry.id };
          // Like native discovery, the first parsed record must be the header.
          break;
        }
        if (!bytesRead || discovered) break;
        if (consumed >= 65536) throw Error("Retained session header exceeds discovery budget; refusing an older substitute");
      }
    } finally { await file.close(); }
  }
}
