import assert from "node:assert/strict";
import { test } from "node:test";
import { semanticTopicLabeler, fastTopicLabeler, tagsOnlyHashtagPlugin } from "../src/topic-labels.js";
import type { TopicLabelerService } from "../src/topic-labels.js";

// Exact body returned by the single deployed Haiku acceptance on 2026-11-14.
const tags = ["gardening", "vegetable-cultivation", "horticulture"];
const json = JSON.stringify(tags);
const fixture = '```json\n["gardening","vegetable-cultivation","horticulture"]\n```';
const label = (raw: string, tagsOnly = true) => semanticTopicLabeler({ review: async (prompt, _model, thinking) => {
  assert.ok(prompt.length <= 4096);
  assert.equal(thinking, "off");
  return raw;
} }, () => "homelab/claude-haiku-4-5-20251001", 2000, false, tagsOnly)("Plant vegetables", []);

test("tags-only accepts plain JSON and exactly one complete optional JSON fence", async () => {
  for (const raw of [json, fixture, `\n ${fixture}\n`, `\`\`\`\n${json}\n\`\`\``, `\`\`\`JSON\r\n${json}\r\n\`\`\``]) {
    assert.deepEqual(await label(raw), tags, raw);
  }
});

test("tags-only rejects prose, partial/multiple fences, wrong language and non-JSON", async () => {
  for (const raw of [
    `Here are tags:\n${fixture}`, `${fixture}\nDone`, `${fixture}\n${fixture}`,
    `\`\`\`json\n${json}`, `${json}\n\`\`\``, `\`\`\`json ${json}\`\`\``,
    `\`\`\`javascript\n${json}\n\`\`\``, `\`\`\`\`json\n${json}\n\`\`\`\``,
    `\`\`\`json\nnot JSON\n\`\`\``, `\`\`\`json\n${json}\n${json}\n\`\`\``,
    `\`\`\`json\n["bad\`tag"]\n\`\`\``, `\`\`\`json\n["x",]\n\`\`\``,
  ]) await assert.rejects(label(raw), /Automatic topic labels:/, raw);
});

test("fenced JSON retains count, type, slug, length and response-size validation", async () => {
  for (const value of [[], ["a", "b", "c", "d"], [1], [null], ["Upper"], ["bad_tag"], ["#tag"],
    ["bad--tag"], ["a-"], ["é"], ["a".repeat(49)], { tags: ["a"] }, null]) {
    for (const raw of [JSON.stringify(value), `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``]) {
      await assert.rejects(label(raw), /Automatic topic labels:/, raw);
    }
  }
  assert.deepEqual(await label(`\`\`\`json\n["${"a".repeat(48)}"]\n\`\`\``), ["a".repeat(48)]);
  await assert.rejects(label(`\`\`\`json\n${" ".repeat(2000)}["a"]\n\`\`\``), /invalid response/);
  assert.deepEqual(await label('```json\n["a","a"]\n```'), ["a"]);
});

test("structured default classifier does not acquire fenced-output compatibility", async () => {
  const raw = '{"topic":null,"inherit":false,"tags":["gardening"]}';
  assert.deepEqual(await label(raw, false), ["gardening"]);
  await assert.rejects(label(`\`\`\`json\n${raw}\n\`\`\``, false), /Automatic topic labels:/);
});

test("actual tags-only service path accepts real fixture, invalid output stays neutral with no fallback request", async () => {
  let response = fixture;
  let calls = 0;
  let service: TopicLabelerService | undefined;
  const backend = { review: async () => { calls++; return response; } };
  await tagsOnlyHashtagPlugin(backend, () => "haiku").activate!({
    registerService(name: string, version: number, implementation: unknown) {
      assert.equal(name, "topic-labeler-tags-only");
      assert.equal(version, 1);
      service = implementation as TopicLabelerService;
    },
  } as any);
  const classify = fastTopicLabeler(backend, () => ["haiku"], {
    get: (name: string) => name === "topic-labeler-tags-only" ? { version: 1, implementation: service! } : undefined,
  }, 2000, () => "tags-only");
  assert.deepEqual(await classify("Plant vegetables", []), tags);
  assert.equal(calls, 1);
  response = `prose\n${fixture}`;
  assert.deepEqual(await classify("Plant vegetables", []), ["topic-clarification"]);
  assert.equal(calls, 2);
});
