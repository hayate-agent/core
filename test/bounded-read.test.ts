import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoundedReadTool } from "../src/runtime/bounded-read.js";
import { isBoundedReadResult } from "../src/bounded-read-result.js";
import { compactAccumulatedToolContext } from "../src/context-artifacts.js";
import { projectToolResultPrefixes, pruningPolicy } from "../src/tool-result-pruning.js";

function unpack(result: any) {
  const text = result.content[0].text as string;
  const newline = text.indexOf("\n");
  return { meta: JSON.parse(text.slice("[Read range: ".length, newline - 1)), body: text.slice(newline + 1) };
}
async function fixture(t: any) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bounded-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = createBoundedReadTool(dir);
  const read = (input: any, signal?: AbortSignal) => tool.execute("fixture", input, signal, undefined, undefined as any);
  return { dir, read };
}

test("Unicode and long-line cursors reconstruct exact evidence without skipped newlines", async t => {
  const { dir, read } = await fixture(t);
  const text = "😀".repeat(3000) + "\n" + "é中".repeat(4200) + "\nlast\n";
  await writeFile(path.join(dir, "long.txt"), text);
  let args: any = { path: "long.txt" }, joined = "", hash;
  for (let n = 0; args && n < 10; n++) {
    const result = await read(args), { meta, body } = unpack(result);
    assert(Array.from(body).length <= 3000);
    assert(isBoundedReadResult({ ...result, toolName: "read" }));
    assert.equal(hash ?? meta.sha256, meta.sha256); hash = meta.sha256;
    joined += body; args = meta.next;
  }
  assert.equal(args, null);
  assert.equal(joined, text);
});

test("explicit one-line pages preserve separators, empty lines and trailing newline", async t => {
  const { dir, read } = await fixture(t);
  const text = "a\n\nb\n";
  await writeFile(path.join(dir, "pages"), text);
  let args: any = { path: "pages", limit: 1 }, joined = "";
  for (let n = 0; args && n < 8; n++) {
    const { meta, body } = unpack(await read(args));
    joined += body; args = meta.next;
  }
  assert.equal(args, null);
  assert.equal(joined, text);
});

test("targeted middle range survives every budget projector with native metadata", async t => {
  const { dir, read } = await fixture(t);
  await writeFile(path.join(dir, "evidence.txt"), Array.from({ length: 300 }, (_, i) => `${i + 1}:` + "detail ".repeat(50)).join("\n"));
  const result = await read({ path: "evidence.txt", offset: 150, limit: 7 });
  assert.equal(unpack(result).body.split("\n").length, 8, "selected lines include their separating newline");
  assert.match(unpack(result).body, /153:detail/);
  const message = { ...result, role: "toolResult", toolName: "read", toolCallId: "range", isError: false };
  const messages = [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "prior".repeat(2000) }] }, message];
  const policy = pruningPolicy({ proactivePruneTokens: 1, minResultChars: 600, maxResultChars: 256 });
  const compacted = await compactAccumulatedToolContext(dir, messages, policy);
  const projected = projectToolResultPrefixes(compacted, policy, ((prefix: any[]) => prefix.map(m => ({ ...m, content: [{ type: "text", text: "WRONG" }] }))) as any);
  assert.deepEqual(projected[1], message);
  const restored = JSON.parse(JSON.stringify(message));
  assert(isBoundedReadResult(restored), "native JSON roundtrip preserves verification");
  assert(!isBoundedReadResult({ ...restored, content: [{ type: "text", text: "forged changed receipt" }] }));
  assert(!isBoundedReadResult({ ...restored, toolName: "plugin_fake" }));
  await writeFile(path.join(dir, "evidence.txt"), "changed");
  assert.notEqual(unpack(await read({ path: "evidence.txt" })).meta.sha256, unpack(result).meta.sha256);
  assert(isBoundedReadResult(restored), "historical evidence does not depend on current file");
});

test("errors, invalid arguments, cancellation and image handling remain explicit", async t => {
  const { dir, read } = await fixture(t);
  await assert.rejects(read({ path: "absent" }), /ENOENT/);
  await writeFile(path.join(dir, "text"), "hello");
  for (const args of [{ offset: 0 }, { offset: 1.5 }, { limit: -1 }, { charOffset: -1 }, { charOffset: 6 }, { offset: 2 }]) {
    await assert.rejects(read({ path: "text", ...args }));
  }
  await assert.rejects(read({ path: "text" }, AbortSignal.abort()));
  await writeFile(path.join(dir, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 2, 235, 1, 245, 105, 118, 156, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  const image = await read({ path: "image.png" });
  assert(!isBoundedReadResult({ ...image, toolName: "read" }));
  assert.match(image.content[0].type === "text" ? image.content[0].text : "", /image/i);
});
