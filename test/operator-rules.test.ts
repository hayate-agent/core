import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperatorRules } from "../src/operator-rules.js";
import { operatorRulesPlugin } from "../src/operator-rules-plugin.js";
import type { Inbound } from "../src/types.js";

const input = (text: string): Inbound => ({ source: "channel", sessionKey: "matrix:operator", id: "event-original", text });
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), "operator-rules-")); t.after(() => rm(home, { recursive: true, force: true }));
  const rules = new OperatorRules(home); await rules.load(); return { rules, home };
}
test("operator rule schema exposes the same key grammar as persistence", async () => {
  let tool: any;
  await operatorRulesPlugin({} as any, {} as any, () => false, async () => false).activate({ registerTool: (value: unknown) => { tool = value; } } as any);
  const pattern = new RegExp(tool.parameters.properties.key.pattern);
  assert.equal(pattern.test("peter-receipts-language"), true);
  assert.equal(pattern.test("peter.receipts.language"), false);
});
test("exact enduring correction survives restart independently of memory and recipes", async t => {
  const { rules, home } = await fixture(t);
  const original = input("RECEIPTS SIND IMMER AUF ENGLISCH ZU HALTEN! Speichere das dauerhaft.");
  await rules.change(original, { key: "receipt-language", text: "RECEIPTS SIND IMMER AUF ENGLISCH ZU HALTEN!", expectedRevision: 0 }, async evidence => {
    assert.equal((evidence as any).source.text, original.text); return true;
  }, () => true);
  const reopened = new OperatorRules(home); await reopened.load();
  assert.equal(reopened.snapshot().rules[0].source.id, "event-original");
  assert.equal(reopened.snapshot().rules[0].source.text, original.text);
  assert.match(reopened.instructions(), /RECEIPTS SIND IMMER AUF ENGLISCH/);
  assert.match(reopened.instructions(), /delegated children/);
  assert.match(reopened.instructions(), /contradictory learned recipes/);
  const raw = await readFile(path.join(home, "operator-rules/rules.json"), "utf8"); assert(raw.includes(original.text));
});
test("quoted wrong assistant assertion cannot become a rule when semantic attribution rejects it", async t => {
  const { rules } = await fixture(t);
  const quoted = input('Du schreibst: "Receipts auf Deutsch". NEIN! Passe deine Skills an!');
  await assert.rejects(rules.change(quoted, { key: "receipt-language", text: "Receipts auf Deutsch", expectedRevision: 0 }, async () => false, () => true), /not supported/);
  assert.equal(rules.snapshot().revision, 0);
  await assert.rejects(rules.change(quoted, { key: "receipt-language", text: "Always German", expectedRevision: 0 }, async () => true, () => true), /Exact/);
});
test("children and host continuations cannot save preferences; stale input and revision reject", async t => {
  const { rules } = await fixture(t);
  for (const turn of [{ ...input("Always English"), source: "api" as const }, { ...input("Always English"), source: "cron" as const }, { ...input("Always English"), sessionKey: "dispatch:child:claim" }, { ...input("Always English"), continuationDepth: 1 }])
    await assert.rejects(rules.change(turn, { key: "language", text: "Always English", expectedRevision: 0 }, async () => true, () => true), /Exact/);
  let current = true;
  await assert.rejects(rules.change(input("Always English"), { key: "language", text: "Always English", expectedRevision: 0 }, async () => { current = false; return true; }, () => current), /not supported/);
  await rules.change(input("Always English"), { key: "language", text: "Always English", expectedRevision: 0 }, async () => true, () => true);
  await assert.rejects(rules.change(input("Always German"), { key: "language", text: "Always German", expectedRevision: 0 }, async () => true, () => true), /revision/);
  await rules.change(input("Always German"), { key: "language", text: "Always German", expectedRevision: 1 }, async () => true, () => true);
  assert.equal(rules.snapshot().rules.length, 1);
  assert.equal(rules.snapshot().rules[0].text, "Always German");
});
