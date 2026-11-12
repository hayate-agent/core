import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "./types.js";
import type { ReviewExecutionRequest, ReviewExecutionReceipt } from "./review-execution.js";

const exec = promisify(execFile);
/** Immutable local snapshot and explicit handover, never another review budget. */
export async function handoverWorktreeReview(runtime: AgentRuntime, request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt> {
  const git = async (args: string[]) => (await exec("git", args, { cwd: request.cwd, maxBuffer: 2 * 1024 * 1024 })).stdout;
  const directory = await mkdtemp(path.join(os.tmpdir(), "dedicated-review-"));
  const worktree = path.join(directory, "candidate");
  let added = false;
  try {
    if (request.signal?.aborted) throw Error("Review cancelled");
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const diff = await git(["diff", "--binary", "HEAD"]);
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const files: Array<[string, Buffer]> = [];
    let bytes = Buffer.byteLength(diff);
    for (const name of untracked) {
      // A local dependency link isn't part of the changeset or executable context.
      if (name === "node_modules") continue;
      if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw Error("Unsafe review snapshot path");
      if (!(await lstat(path.join(request.cwd, name))).isFile()) throw Error("Nonregular review snapshot file");
      const content = await readFile(path.join(request.cwd, name)); bytes += content.length;
      if (bytes > 512 * 1024) throw Error("Review snapshot exceeds bound");
      files.push([name, content]);
    }
    if (bytes > 512 * 1024) throw Error("Review snapshot exceeds bound");
    await git(["worktree", "add", "--detach", worktree, head]); added = true;
    if (diff) {
      const patch = path.join(directory, "candidate.patch"); await writeFile(patch, diff);
      await exec("git", ["apply", "--binary", patch], { cwd: worktree });
    }
    for (const [name, content] of files) {
      let parent = worktree;
      for (const component of name.split("/").slice(0, -1)) {
        parent = path.join(parent, component);
        try { if ((await lstat(parent)).isSymbolicLink()) throw Error("Symlink in review snapshot destination"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await mkdir(path.dirname(path.join(worktree, name)), { recursive: true });
      await writeFile(path.join(worktree, name), content);
    }
    // Include untracked content in drift checks, not just HEAD/tracked diff.
    const currentUntracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(name => name && name !== "node_modules");
    if (JSON.stringify(currentUntracked) !== JSON.stringify(files.map(([name]) => name))) throw Error("Untracked candidate changed during handover");
    for (const [name, content] of files) {
      if (!(await lstat(path.join(request.cwd, name))).isFile() || !(await readFile(path.join(request.cwd, name))).equals(content)) throw Error("Untracked candidate changed during handover");
    }
    // Caller still owns final changeset revalidation; reject obvious snapshot drift.
    if ((await git(["rev-parse", "HEAD"])).trim() !== head || await git(["diff", "--binary", "HEAD"]) !== diff) throw Error("Candidate changed during handover");
    const id = `review-handover:${randomUUID()}`;
    if (!runtime.forReviewWorktree) throw Error("Runtime cannot isolate review worktree");
    const isolated = runtime.forReviewWorktree(worktree);
    const session = await isolated.open(id, { ephemeral: true });
    const controller = new AbortController();
    let timedOut = false;
    let aborting: Promise<void> | undefined;
    const abort = () => { controller.abort(); aborting ??= Promise.resolve().then(() => session.abort()).catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, 120000);
    timer.unref?.();
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (!session.seedHandover) throw Error("Runtime cannot seed dedicated review handover");
      await session.seedHandover(`Dedicated read-only review. Fresh isolated candidate snapshot: ${worktree}. Original parent: ${request.sessionKey}. Candidate fingerprint: ${request.fingerprint}. No working tools, no new authority, no budget reset. Review the supplied changeset, not prior self-assessments.`);
      if (request.signal?.aborted) throw Error("Review cancelled");
      const result = request.httpAssessment
        ? await (async () => {
          if (!isolated.reviewCodeHttp) throw Error("Dedicated HTTP review unavailable");
          return isolated.reviewCodeHttp(request.prompt, request.httpAssessment!, id, controller.signal);
        })()
        : await session.prompt(request.prompt, { model: request.model, thinking: request.thinking });
      if (request.signal?.aborted || timedOut) throw Error("Review cancelled or timed out");
      return { kind: "handover-worktree", executionId: id, isolated: true, fingerprint: request.fingerprint, result };
    } finally {
      clearTimeout(timer); request.signal?.removeEventListener("abort", abort);
      await aborting; await session.dispose();
    }
  } finally {
    if (added) await git(["worktree", "remove", "--force", worktree]);
    await rm(directory, { recursive: true, force: true });
  }
}
