import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { completionStrategy, completionStrategyHolder } from "../src/completion-strategy.js";
import { assessCompletion } from "../src/completion-check.js";

test("custom advisory prompt is selected but host still rejects expiry and invalid results", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "completion-strategy-")); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "strategy.mjs"), `export default {apiVersion:1,label:'custom',prompt(){return this.label}}`);
  const prompt = await completionStrategy(home, "strategy.mjs", { apiVersion: 1, prompt() { throw Error("not selected"); } });
  const input = { sessionKey: "test", text: "finish approved work", source: "channel" as const };
  let calls = 0;
  const backend = { async review(text: string) { calls++; assert.equal(text, "custom"); return '{"state":"continue","next":"verify approved result"}'; } };
  assert.deepEqual(await assessCompletion(backend, input, "unfinished", { task: input.text, expiresAt: 2000 }, new AbortController().signal, undefined, () => 1000, prompt), { state: "continue", next: "verify approved result", expiresAt: 2000 });
  assert.equal(await assessCompletion(backend, input, "unfinished", { task: input.text, expiresAt: 1000 }, new AbortController().signal, undefined, () => 1000, prompt), undefined);
  assert.equal(calls, 1);
  assert.equal(await assessCompletion({ async review() { return '{"state":"continue","next":""}'; } }, input, "unfinished", { task: input.text }, new AbortController().signal, undefined, () => 1000, prompt), undefined);
  assert.equal(await assessCompletion(backend, input, "unfinished", { task: input.text }, new AbortController().signal), undefined, "no injected strategy means no implicit classification");
});
test("holder restores configured installation baseline and disabled mode does not classify", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "completion-holder-")); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "installed.mjs"), "export default {apiVersion:1,label:'installed',prompt(){return this.label}}");
  await writeFile(path.join(home, "local.mjs"), "export default {apiVersion:1,prompt(){return 'local'}}");
  const builtin = { apiVersion: 1 as const, prompt: () => "builtin" };
  const input = { sessionKey: "test", text: "task", source: "channel" as const };
  const invoke = (holder: Awaited<ReturnType<typeof completionStrategyHolder>>) => holder.current?.(input, "", { task: "task" }, Date.now);
  assert.equal(invoke(await completionStrategyHolder(home, undefined, builtin, undefined)), "builtin");
  const holder = await completionStrategyHolder(home, "installed.mjs", builtin, "local.mjs");
  assert.equal(invoke(holder), "local");
  await holder.change(undefined, async () => {}); assert.equal(invoke(holder), "installed");
  const disabled = await completionStrategyHolder(home, "installed.mjs", builtin, null);
  let calls = 0;
  assert.equal(await assessCompletion({ async review() { calls++; return "{}"; } }, input, "reply", { task: "task" },
    new AbortController().signal, undefined, Date.now, disabled.current), undefined);
  assert.equal(calls, 0);
});

test("invalid/missing completion module fails startup, not fallback", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "completion-invalid-")); t.after(() => rm(home, { recursive: true, force: true }));
  const baseline = { apiVersion: 1 as const, prompt: () => "baseline" };
  await assert.rejects(completionStrategy(home, "missing.mjs", baseline));
  await writeFile(path.join(home, "bad.mjs"), 'export default {apiVersion:1,prompt:42}');
  await assert.rejects(completionStrategy(home, "bad.mjs", baseline), /Invalid completion strategy/);
  const prompt = await completionStrategy(home, undefined, baseline);
  assert.equal(prompt({ sessionKey: "test", text: "", source: "channel" }, "", { task: "test" }, Date.now), "baseline");
});
