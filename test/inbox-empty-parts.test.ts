import assert from "node:assert/strict";
import { test } from "node:test";
import { idsOf } from "../src/delivery/inbox.js";
import type { Inbound } from "../src/types.js";

const base = { sessionKey: "s", source: "api", text: "hi" } as unknown as Inbound;

test("idsOf falls back to the top-level id when parts is empty", () => {
  assert.deepEqual(idsOf({ ...base, id: "event-1", parts: [] }), ["event-1"]);
});

test("idsOf falls back to the top-level id when parts is missing", () => {
  assert.deepEqual(idsOf({ ...base, id: "event-1" }), ["event-1"]);
});

test("idsOf keeps part ids for non-empty parts", () => {
  assert.deepEqual(idsOf({ ...base, id: "event-1", parts: [{ id: "p1", text: "a" }, { id: "p2", text: "b" }] } as Inbound), ["p1", "p2"]);
});
