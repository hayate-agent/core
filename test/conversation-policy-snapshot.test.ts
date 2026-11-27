import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeConversationPolicy, gatewaySettings, type ConversationPolicy } from "../src/gateway-settings.js";

function fixture(): ConversationPolicy {
  return { defaults: { users: ["alice"], activation: "mentions" }, allowedChannels: ["room"], channels: { room: { users: ["bob"], activation: "open" } } };
}
for (const field of ["defaults", "allowedChannels", "channelUsers", "channelRule"] as const) {
  test(`base ${field} mutation cannot change merged policy`, () => {
    const base = fixture(), merged = mergeConversationPolicy(base)!;
    const before = structuredClone(merged);
    if (field === "defaults") (base.defaults!.users as string[]).push("mallory");
    if (field === "allowedChannels") (base.allowedChannels as string[]).push("other");
    if (field === "channelUsers") (base.channels!.room.users as string[]).push("mallory");
    if (field === "channelRule") base.channels!.room.activation = "disabled";
    assert.deepEqual(merged, before);
  });
}
for (const field of ["defaults", "allowedChannels", "channelUsers"] as const) {
  test(`override ${field} mutation cannot change merged policy`, () => {
    const override = fixture(), merged = mergeConversationPolicy(undefined, override)!;
    const before = structuredClone(merged);
    if (field === "defaults") (override.defaults!.users as string[]).push("mallory");
    if (field === "allowedChannels") (override.allowedChannels as string[]).push("other");
    if (field === "channelUsers") (override.channels!.room.users as string[]).push("mallory");
    assert.deepEqual(merged, before);
  });
}
test("merged mutation does not change either input", () => {
  const base = fixture(), override: ConversationPolicy = { defaults: { users: ["carol"] } };
  const before = structuredClone({base, override}), merged = mergeConversationPolicy(base, override)!;
  (merged.defaults!.users as string[]).push("mallory");
  (merged.allowedChannels as string[]).push("other");
  merged.channels!.room.activation = "disabled";
  assert.deepEqual({base, override}, before);
});
test("denial arrays and field overrides retained", () => {
  const merged = mergeConversationPolicy(fixture(), { allowedChannels: [], defaults: { users: [] }, channels: { room: { activation: "disabled" } } })!;
  assert.deepEqual(merged.allowedChannels, []);
  assert.deepEqual(merged.defaults, {users: [], activation: "mentions"});
  assert.deepEqual(merged.channels!.room, {users: ["bob"], activation: "disabled"});
  assert.equal(mergeConversationPolicy(), undefined);
});
test("gateway settings built later see original merge snapshot", () => {
  const base = fixture(), policy = mergeConversationPolicy(base)!;
  base.channels!.room.activation = "disabled";
  const settings = gatewaySettings({overrides: {matrix: {conversation: policy}}}, "matrix");
  assert.equal(settings.conversation!.channels!.room.activation, "open");
});
