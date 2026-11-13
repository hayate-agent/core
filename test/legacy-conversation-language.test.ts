import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

for (const source of ["heartbeat", "cron"] as const) test(`legacy conversation recovered through ${source} does not become English background work`, async () => {
  const runtime = new FakeRuntime(() => "Prüfung durchgeführt"), h = new Harness({ runtime, language: () => ({ default: "en" }), tickMs: 60000, log: () => {} });
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel()); await h.start();
  try {
    const original = "Bitte prüfe den vorhandenen Stand ohne neue Änderungen.";
    await h.accept({ source, sessionKey: "mem:room1", taskId: "original", text: original,
      completionAnchor: { id: "original", task: original, receivedAt: 1, replyTo: { channel: "mem", target: "room1" } } });
    await h.drained();
    const instructions = runtime.sessions.get("mem:room1")!.options[0].instructions!;
    assert.match(instructions, /Match the current user's conversational language/);
    assert.doesNotMatch(instructions, /Write natural-language output in en/);
  } finally { await h.stop(0); }
});

test("explicit background provenance wins even when a job delivers to a conversation", async () => {
  const runtime = new FakeRuntime(() => "Job result"), h = new Harness({ runtime, language: () => ({ default: "en" }), tickMs: 60000, log: () => {} });
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel()); await h.start();
  try {
    const text = "Check configured status";
    await h.accept({ source: "cron", sessionKey: "mem:room1", taskId: "job", text,
      completionAnchor: { id: "job", task: text, receivedAt: 1, language: "es", languageContext: "background" } });
    await h.drained(); assert.match(runtime.sessions.get("mem:room1")!.options[0].instructions!, /output in es/);
  } finally { await h.stop(0); }
});
