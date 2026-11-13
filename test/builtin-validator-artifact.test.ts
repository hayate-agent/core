import assert from "node:assert/strict";
import { test } from "node:test";

// Exercise the shipped JavaScript, not the generated TypeScript source. npm test
// builds first; a missing lock entry or missing compiled export must fail here.
const artifact = (file: string) => new URL(`../dist/${file}.js`, import.meta.url).href;

test("built TypeSafe provider exports register with the built Core host and remain explicitly selected", async t => {
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("registration must not use the network"); });
  const { createTypeSafeProvider, createTypeSafeValidatorPlugin } = await import(artifact("builtin-plugins/typesafe-validator-provider"));
  const { PluginHost } = await import(artifact("plugins"));
  assert.equal(typeof createTypeSafeProvider, "function");
  assert.equal(typeof createTypeSafeValidatorPlugin, "function");

  // Test-only factory data: registration must not contact any endpoint. No
  // operator configuration, model, credentials or live service is consulted.
  const config = {
    endpoint: "https://typesafe.invalid/v1/systemone",
    model: "artifact-test",
    questionbank: {
      id: "artifact-test",
      instructions: "Choose whether this test fixture is complete.",
      choices: {
        done: { description: "Complete", category: "completed" },
        unknown: { description: "Cannot determine", category: "uncertain" },
      },
    },
  };
  const host = new PluginHost();
  try {
    assert.equal(createTypeSafeProvider(config).name, "typesafe");
    host.validators.select("typesafe"); // Same selection-before-load order as CLI startup.
    assert.throws(() => host.validators.current, /not registered/);
    await host.load([], { agent: "artifact-test", home: "/unused", cwd: "/unused" }, [], [], [createTypeSafeValidatorPlugin(config)]);
    assert.deepEqual(host.validators.versions(), [{ name: "typesafe", version: 1, apiVersion: 1 }]);
    assert.equal(host.validators.selected, "typesafe");
    assert.equal(host.validators.current?.name, "typesafe");
    assert.equal(typeof host.validators.current?.assess, "function");
    host.validators.select("missing-provider");
    assert.throws(() => host.validators.current, /not registered/, "missing selection must fail explicitly");
    host.validators.select(false);
    assert.equal(host.validators.current, undefined, "disabled selection must not activate a provider");
    assert.equal(network.mock.callCount(), 0);
  } finally {
    await host.stop();
  }
});
