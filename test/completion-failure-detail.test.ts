import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCompletion } from "../src/completion-check.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { ValidatorRegistry } from "../src/validator.js";

async function failure(assess: () => Promise<unknown>, timeoutMs = 1000) {
  const registry = new ValidatorRegistry();
  registry.register({ apiVersion: 1, name: "fixture", version: 1, assess });
  registry.select("fixture");
  const diagnostics: unknown[][] = [];
  const verdict = await assessCompletion({ review: async () => "unused" },
    { sessionKey: "parent", source: "channel", text: "authorized work" }, "settled result",
    { task: "authorized work" }, new AbortController().signal, undefined, Date.now, completionPrompt,
    ((...args: unknown[]) => diagnostics.push(args)), timeoutMs, registry);
  assert.equal(verdict, undefined, "a technical failure never grants continuation");
  return diagnostics;
}

test("completion provider failures retain only bounded structured cause, never exception text", async () => {
  const secret = "https://user:password@private.example/?token=secret Authorization: Bearer private";
  const error = Object.assign(new Error(secret), { code: "ECONNRESET", status: 503, headers: { authorization: secret } });
  const diagnostics = await failure(async () => { throw error; });
  assert.deepEqual(diagnostics, [["technical", { cause: "provider_error", code: "ECONNRESET", status: 503 }]]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /password|private|token|Authorization/);
  const untrusted = await failure(async () => { throw Object.assign(new Error(secret), { code: secret, status: secret }); });
  assert.deepEqual(untrusted, [["technical", { cause: "provider_error" }]]);
});

test("completion timeout and malformed answer are distinguishable without opening the gate", async () => {
  assert.deepEqual(await failure(() => new Promise(() => {}), 5), [["technical", { cause: "timeout" }]]);
  assert.deepEqual(await failure(async () => ({ state: "continue", next: "" })), [["invalid_response", { cause: "invalid_shape" }]]);
});
