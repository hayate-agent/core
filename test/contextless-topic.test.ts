import assert from "node:assert/strict";
import { test } from "node:test";
import { semanticTopicLabeler } from "../src/topic-labels.js";
import { parseHashtags } from "../src/hashtags.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { ActivityEvent } from "../src/activity.js";

const tags = ["agent-stall", "conversation-context", "hashtag-management", "overnight-work", "result-routing", "validator"];
const complaint = `task 7a074fb375ccdff5 · ${tags.map(t => "#" + t).join(" ")} · Main · 30s · model example · Werkzeug bash: completed\n\nOk. STOP! Das sind kopierte Labels. Finde und fixe die Ursache.`;
async function drained(h: Harness) {
  for (let n = 0; n < 1000; n++) { if (h.isDrained()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error("not drained");
}

test("related candidate is not full-subject continuation; explicit inheritance remains available", async () => {
  const candidates = [{ id: "a", text: "old multi-topic work", tags }];
  let verdict: unknown = { topic: "a", inherit: false, tags: ["overnight-work"] };
  const label = semanticTopicLabeler({ review: async () => JSON.stringify(verdict) }, () => undefined);
  assert.deepEqual(await label("Warum keine Nachtarbeit?", candidates), ["overnight-work"]);
  verdict = { topic: null, inherit: false, tags: ["topic-clarification"] };
  assert.deepEqual(await label("Was ist passiert?", candidates), ["topic-clarification"]);
  verdict = { topic: "a", inherit: true, tags: [] };
  assert.deepEqual(await label("Führe genau diesen gesamten Auftrag weiter", candidates), tags);
  for (const inherit of [undefined, "true", 1]) {
    verdict = { topic: "a", inherit, tags: ["overnight-work"] };
    await assert.rejects(label("work", candidates), /invalid response/);
  }
  assert.deepEqual(parseHashtags(complaint), []);
  assert.deepEqual(parseHashtags(complaint + "\n#chosen-topic"), ["chosen-topic"]);
});

test("real Harness queues standalone messages and quoted STOP without borrowing active bundle; native activity follows each input", async t => {
  const events: ActivityEvent[] = [];
  let calls = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => "answer"), tickMs: 60000, busyMode: "queue",
    topicLabeler: semanticTopicLabeler({ review: async prompt => {
      calls++;
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      const candidate = data.candidates.find((c: { text: string }) => c.text.startsWith("Old bundle"));
      assert.ok(candidate);
      if (data.incoming.includes("Nachtarbeit")) return JSON.stringify({ topic: candidate.id, inherit: false, tags: ["overnight-work"] });
      if (data.incoming.includes("STOP")) return JSON.stringify({ topic: null, inherit: false, tags: ["hashtag-assignment"] });
      if (data.incoming.includes("gesamten")) return JSON.stringify({ topic: candidate.id, inherit: true, tags: [] });
      return JSON.stringify({ topic: null, inherit: false, tags: ["topic-clarification"] });
    } }, () => undefined) });
  const channel = Object.assign(new MemoryChannel(), { taskActivity: (_to: unknown, event: ActivityEvent) => events.push(event) });
  h.addChannel(channel); await h.start(); t.after(() => h.stop(1000));
  await h.accept(msg(`Old bundle ${tags.map(t => "#" + t).join(" ")}`)); await drained(h);
  const inputs = ["Was ist passiert?", "Ich sehe jetzt zum zweiten Mal in Folge keine Nachtarbeit. Warum nicht? Was ist da passiert?", complaint, "Führe den gesamten alten Auftrag weiter"];
  const expected = [["topic-clarification"], ["overnight-work"], ["hashtag-assignment"], tags];
  for (let i = 0; i < inputs.length; i++) {
    events.length = 0;
    await h.accept(msg(inputs[i]!)); await drained(h);
    assert.ok(events.length);
    for (const event of events) assert.deepEqual([...event.snapshot.outputTags!].sort(), [...expected[i]!].sort());
    assert.equal(channel.texts().at(-1), expected[i]!.map(t => "#" + t).sort().join(" ") + " · answer");
  }
  assert.equal(calls, 4, "copied activity tags must not bypass semantic classification");
});
