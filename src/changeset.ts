import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const LIMIT = 512 * 1024;
export async function resolveReviewBase(cwd: string, configured?: string): Promise<string> {
  if (configured) return (await git(cwd, ["merge-base", "HEAD", configured])).trim();
  try { return (await git(cwd, ["merge-base", "HEAD", "@{upstream}"])).trim(); }
  catch { return (await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim(); }
}
export async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", ["--no-pager", ...args], {
    cwd, maxBuffer: LIMIT, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  })).stdout;
}
export interface Changeset { root: string; base: string; fingerprint: string; diff: string; files: string[] }
export async function captureChangeset(cwd: string, baseRef: string): Promise<Changeset> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const base = (await git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
  let diff = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", base, "--"]);
  const tracked = (await git(root, ["diff", "--no-renames", "--name-only", "-z", base, "--"])).split("\0").filter(Boolean);
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  for (const file of untracked) {
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("Invalid changeset path");
    const info = await lstat(absolute);
    if (!info.isFile()) throw new Error("Untracked non-regular file requires operator review");
    if (info.size > LIMIT) throw new Error("Changeset exceeds review size limit");
    const body = await readFile(absolute);
    if (body.includes(0)) throw new Error("Untracked binary file requires operator review");
    if (!isUtf8(body)) throw new Error("Untracked invalid UTF-8 file requires operator review");
    diff += `\nUntracked file ${JSON.stringify(file)}\n${body.toString("utf8")}\n`;
    if (Buffer.byteLength(diff) > LIMIT) throw new Error("Changeset exceeds review size limit");
  }
  if (Buffer.byteLength(diff) > LIMIT) throw new Error("Changeset exceeds review size limit");
  return { root, base, diff, files: [...new Set([...tracked, ...untracked])].sort(), fingerprint: createHash("sha256").update(base).update("\0").update(diff).digest("hex") };
}
