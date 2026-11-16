import test from "node:test";
import assert from "node:assert/strict";
import { resourceUsageLabel } from "../src/resource-usage-label.js";

test("resource activity uses conversation locale, name and actual action with English fallback", () => {
  assert.match(resourceUsageLabel({ resource: "skill", action: "loaded", name: "pdf", locale: "de" }), /Skill pdf geladen/);
  assert.match(resourceUsageLabel({ resource: "skill", action: "created", name: "pdf", locale: "en" }), /Skill pdf created/);
  assert.match(resourceUsageLabel({ resource: "skill", action: "updated", name: "pdf", locale: "es" }), /pdf actualizado/);
  assert.match(resourceUsageLabel({ resource: "memory", action: "recalled", locale: "ru" }), /Рабочая память/);
  assert.match(resourceUsageLabel({ resource: "skill", action: "updated", name: "pdf", locale: "fr" }), /pdf updated/);
  assert.doesNotMatch(resourceUsageLabel({ resource: "skill", action: "loaded", name: "../secret", locale: "en" }), /secret/);
});
