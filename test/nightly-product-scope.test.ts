import test from "node:test";
import assert from "node:assert/strict";
import { improvementPrompt } from "../src/builtin-plugins/nightly-default.js";
import { improvementPolicy } from "../src/improvement.js";

test("nightly candidates cover the whole product without granting foreign edits or artificial quotas", () => {
  const prompt = improvementPrompt(improvementPolicy({ maxTurns: 50, pullRequest: false, merge: false }), 3);
  for (const phrase of ["gesamten Agentenprodukt", "Core, Dispatcher, Validator", "Plugins und Integrationen",
    "bestehende Features", "fehlende Features", "Nicht-Hayate-Agenten", "Lizenz und Herkunft",
    "kleine vertikale Experimente", "Keine fremden Projekte verändern", "keine Feature- oder Experimentquote",
    "kein künstliches Aufbrauchen", "unabhängigen Abschlussprüfung", "im selben Kontext"])
    assert.ok(prompt.includes(phrase), phrase);
  assert.match(prompt, /Turn 3\/50/);
  assert.match(prompt, /PR-Erstellung nicht erlaubt; Merge nicht erlaubt/);
  assert.match(prompt, /keine produktiven Memories, geschützte Policy oder laufenden Adapter verändern/);
  assert.match(prompt, /Operator-Arbeit hat Vorrang/);
  assert.match(prompt, /nur automatische Übernahme\/Merge sind dann verboten/);
});
