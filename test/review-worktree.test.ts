import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { handoverWorktreeReview } from "../src/review-worktree.js";
import { FakeRuntime } from "./fakes.js";

for (const mode of ["success", "seed-failure", "cancel"] as const) {
test(`fallback snapshots candidate and cleans worktree: ${mode}`, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-fallback-test-"));
  const git = async (...args: string[]) => promisify(execFile)("git", args, { cwd: home });
  let snapshot = "";
  try {
    await git("init"); await git("config", "user.name", "Review Test"); await git("config", "user.email", "review@example.invalid");
    await writeFile(path.join(home,"file.txt"),"before"); await git("add","file.txt"); await git("commit","-m","baseline");
    await writeFile(path.join(home,"file.txt"),"after"); await writeFile(path.join(home,"new.txt"),"new");
    const abort = new AbortController();
    const runtime = new FakeRuntime(() => '{"findings":[]}'); const open = runtime.open.bind(runtime);
    runtime.open = async (key, options) => {
      assert.equal(options?.ephemeral,true); const session = await open(key,options);
      Object.assign(session,{seedHandover: async (text: string) => {
        snapshot = text.match(/snapshot: (.*)\. Original parent:/)![1];
        assert.equal(await readFile(path.join(snapshot,"file.txt"),"utf8"),"after");
        assert.equal(await readFile(path.join(snapshot,"new.txt"),"utf8"),"new");
        if (mode === "seed-failure") throw Error("handover failed");
        if (mode === "cancel") abort.abort();
      }});return session;
    };
    const review = handoverWorktreeReview(runtime,{cwd:home,sessionKey:"parent",fingerprint:"bytes",prompt:"review patch",thinking:"low",signal:abort.signal});
    if (mode === "seed-failure") await assert.rejects(review,/handover failed/);
    else if (mode === "cancel") await assert.rejects(review,/cancelled/);
    else {
      const receipt = await review;
      assert.equal(receipt.kind,"handover-worktree");assert.equal(receipt.fingerprint,"bytes");
    }
    await assert.rejects(access(snapshot));
    assert.equal(await readFile(path.join(home,"file.txt"),"utf8"),"after");
    assert.equal((await git("worktree","list","--porcelain")).stdout.split("worktree ").length-1,1);
  }finally{await rm(home,{recursive:true,force:true});}
});
}
