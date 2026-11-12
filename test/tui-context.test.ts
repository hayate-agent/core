import assert from "node:assert/strict";
import {test} from "node:test";
import {HarnessTuiChannel} from "../src/channels/tui.js";
import type {ActivityEvent} from "../src/activity.js";

test("TUI keeps worker and classifier identities with original tags through terminal states", () => {
  const ui = new HarnessTuiChannel({});
  // Exercise the actual row projection without starting terminal IO.
  (ui as any).render = () => {};
  const to = ui.address;
  for (const phase of ["running", "blocked", "completed"] as const) {
    for (const [id, role, tag] of [["a", "worker", "appointment"], ["b", "dispatcher-classifier", "security"]] as const) {
      const event: ActivityEvent = {type: "activity", kind: "progress", snapshot: {id, parent: id === "a" ? "01234567-89ab-cdef-0123-456789abcdef" : "11234567-89ab-cdef-0123-456789abcdef", role, context: "worker", outputTags: [tag], phase, activity: "SECRET PROMPT", tools: [], elapsedMs: 0, inactiveMs: 0}};
      ui.taskActivity(to, event);
      const rows = [...(ui as any).classifiers.values()].map((r: any) => r.label);
      assert.ok(rows.some((r: string) => r.includes(`#${tag} · ${phase}`)));
      assert.doesNotMatch(rows.join("\n"), /SECRET PROMPT/);
      assert.deepEqual(event.snapshot.outputTags, [tag]);
    }
  }
  const rows = [...(ui as any).classifiers.values()].map((r: any) => r.label);
  assert.match(rows[0], /^Worker · task 01234567/);
  assert.match(rows[1], /^Dispatcher classifier · task 11234567/);
});
