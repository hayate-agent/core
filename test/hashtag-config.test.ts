import assert from "node:assert/strict";
import { test } from "node:test";
import { hashtagModel } from "../src/hashtag-config.js";
import { topicModelChain } from "../src/topic-labels.js";

const roles = { enabled: true, roles: { basic: { model: "p/basic", thinking: "medium" as const } } };

test("hashtag.model wins over Basic and Main", () => {
  assert.equal(hashtagModel({ hashtag: { model: "p/tag" }, modelRoles: roles, model: "p/main" }), "p/tag");
});
test("Basic (modelRoles.roles.basic) is used when hashtag.model is unset", () => {
  assert.equal(hashtagModel({ modelRoles: roles, model: "p/main" }), "p/basic");
});
test("disabled roles or missing simple fall through to Main of the effective scope", () => {
  assert.equal(hashtagModel({ modelRoles: { ...roles, enabled: false }, model: "p/scope-main" }), "p/scope-main");
  assert.equal(hashtagModel({ modelRoles: { enabled: true, roles: {} }, model: "p/scope-main" }), "p/scope-main");
  assert.equal(hashtagModel({}), undefined);
});
test("topicModelChain applies the same order; call site keeps thinking off", () => {
  assert.deepEqual(topicModelChain(roles, "p/main", "p/tag"), ["p/tag"]);
  assert.deepEqual(topicModelChain(roles, "p/main"), ["p/basic"]);
  assert.deepEqual(topicModelChain(undefined, "p/scope-main"), ["p/scope-main"]);
});

test("conversation-local Main (/model) reaches the hashtag chain as scope Main; Basic and hashtag.model still precede it", async () => {
  const seen: Array<string | undefined> = [];
  const services = { get: () => ({ version: 1, implementation: { label: async () => ["scoped-topic"] } }) } as any;
  const label = (await import("../src/topic-labels.js")).fastTopicLabeler({} as any,
    scopeMain => { const chain = topicModelChain(undefined, scopeMain ?? "p/instance-main"); seen.push(...chain); return chain; }, services);
  await label("text one", [], [], undefined, { model: "p/session-main" });
  await label("text two", [], []);
  assert.deepEqual(seen, ["p/session-main", "p/instance-main"]);
});

test("real Harness.prepareTopic passes the conversation's active Main (scope override) to the topic labeler", async () => {
  const { Harness } = await import("../src/harness.js");
  const { FakeRuntime, MemoryChannel, msg } = await import("./fakes.js");
  const scopes: Array<string | undefined> = [];
  const h = new Harness({ runtime: new FakeRuntime(() => "ok"), tickMs: 60000, busyMode: "queue",
    topicLabeler: async (_t: string, _c: unknown, _r: unknown, _x: unknown, scope?: { model?: string }) => { scopes.push(scope?.model); return ["scope-main"]; } } as any);
  const drained = async () => { for (let n = 0; n < 1000 && !h.isDrained(); n++) await new Promise(r => setTimeout(r, 5)); };
  h.addChannel(new MemoryChannel()); await h.start();
  try {
    await h.accept(msg("first")); await drained();
    const rt = (h as any).opts.runtime as InstanceType<typeof FakeRuntime>;
    for (const s of rt.sessions.values()) await s.setModel("p/session-main");
    await h.accept(msg("second")); await drained();
  } finally { await h.stop(1000); }
  assert.equal(scopes.length, 2);
  assert.equal(scopes[1], "p/session-main");
});

test("plugin path: tags-only service gets scope Main (/model override); Basic and hashtag.model still win; thinking off", async () => {
  const { fastTopicLabeler, tagsOnlyHashtagPlugin } = await import("../src/topic-labels.js");
  const calls: Array<{ model?: string; thinking?: string }> = [];
  const backend = { review: async (_p: string, model?: string, thinking?: string) => { calls.push({ model, thinking }); return '["scoped"]'; } } as any;
  const run = async (settings: { model?: string; hashtag?: { model?: string }; modelRoles?: typeof roles }, scope?: { model?: string }) => {
    const services = new Map<string, unknown>();
    tagsOnlyHashtagPlugin(backend, scopeMain => hashtagModel({ ...settings, model: scopeMain ?? settings.model }))
      .activate({ registerService: (n: string, v: number, impl: unknown) => services.set(n, { version: v, implementation: impl }) } as any);
    calls.length = 0;
    const label = fastTopicLabeler(backend, () => [], { get: (n: string) => services.get(n) } as any, 1000, () => "tags-only");
    assert.deepEqual(await label("hello", [], [], undefined, scope), ["scoped"]);
    return calls[0];
  };
  assert.deepEqual(await run({ model: "p/instance" }, { model: "p/session-main" }), { model: "p/session-main", thinking: "off" });
  assert.deepEqual(await run({ model: "p/instance" }), { model: "p/instance", thinking: "off" });
  assert.deepEqual(await run({ model: "p/instance", modelRoles: roles }, { model: "p/session-main" }), { model: "p/basic", thinking: "off" });
  assert.deepEqual(await run({ model: "p/instance", hashtag: { model: "p/tag" }, modelRoles: roles }, { model: "p/session-main" }), { model: "p/tag", thinking: "off" });
});

test("explicit basic key is validated by the existing modelRoles schema; simple is NOT Basic", async () => {
  const { validateModelRoles } = await import("../src/model-roles.js");
  validateModelRoles({ enabled: true, roles: { basic: { model: "p/basic" } } });
  assert.throws(() => validateModelRoles({ enabled: true, roles: { basic: { model: "nope" } } }), /Invalid role model ref/);
  assert.throws(() => validateModelRoles({ enabled: true, roles: { basic: { model: "p/b", extra: 1 } } }), /Invalid model role/);
  assert.equal(hashtagModel({ model: "p/main", modelRoles: { enabled: true, roles: { simple: { model: "p/simple" } } } as any }), "p/main");
});
