import assert from "node:assert/strict";
import { test } from "node:test";
import { textBlockTracker, toTurnEvent } from "../src/runtime/pi.js";

const update = (type: string, delta?: string) => ({ type: "message_update", assistantMessageEvent: { type, ...(delta === undefined ? {} : { delta }) } }) as any;
const stream = (events: any[]) => {
  const gap = textBlockTracker(); let text = "";
  for (const event of events) {
    const inserted = gap(event); if (inserted?.type === "text") text += inserted.delta;
    const mapped = toTurnEvent(event); if (mapped?.type === "text") text += mapped.delta;
  }
  return text;
};

test("a new text block starts a new paragraph; the first one and deltas inside a block stay untouched", () => {
  assert.equal(stream([update("text_start"), update("text_delta", "Ich lese die "), update("text_delta", "Threads."), update("text_end"),
    update("text_start"), update("text_delta", "Die vier Punkte sind plausibel."), update("text_start"), update("text_delta", "Fertig.")]),
    "Ich lese die Threads.\n\nDie vier Punkte sind plausibel.\n\nFertig.");
});

test("no separator before the first text, none for thinking or tool-call blocks, none for an empty block", () => {
  assert.equal(stream([update("thinking_start"), update("thinking_delta", "x"), update("text_start"), update("text_delta", "A"),
    update("toolcall_start"), update("toolcall_delta", "{}"), update("text_start"), update("text_delta", "")]), "A\n\n");
  assert.equal(stream([update("text_start"), update("text_start"), update("text_delta", "A")]), "A");
});

test("every run starts with a fresh tracker", () => {
  stream([update("text_start"), update("text_delta", "old")]);
  assert.equal(stream([update("text_start"), update("text_delta", "new")]), "new");
});
