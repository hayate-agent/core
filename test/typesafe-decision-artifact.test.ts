import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
const artifact = (name: string) => new URL(`../dist/${name}.js`, import.meta.url).href;

test("built shared transport, both decision exports and host hooks register without network/credential reads", async t => {
  const network = t.mock.method(globalThis, "fetch", () => { throw Error("No network during registration"); });
  const { PluginHost } = await import(artifact("plugins"));
  const { createTypeSafeAPIPlugin } = await import(artifact("builtin-plugins/typesafe-api-plugin"));
  const { typeSafeDecisionPlugin, TYPESAFE_VALIDATOR, TYPESAFE_DISPATCHER, COMPLETION_BANK, DISPATCH_BANK, READY_BANK } = await import(artifact("builtin-plugins/typesafe-decision-plugin"));
  for (const reverse of [false, true]) {
    const host = new PluginHost();
    host.validators.select(TYPESAFE_VALIDATOR); host.dispatchDecisions.select(TYPESAFE_DISPATCHER);
    const modules = [typeSafeDecisionPlugin, createTypeSafeAPIPlugin({ endpoint: "https://gateway.example.invalid/v1/systemone", model: "openjev-latest", bearerTokenFile: "/does/not/exist/registration-must-not-read" })];
    try {
      await host.load([], { agent: "test", home: "/unused", cwd: "/unused" }, [], [], reverse ? modules.reverse() : modules);
      assert.equal(host.validators.current.name, TYPESAFE_VALIDATOR);
      assert.equal(host.dispatchDecisions.current.name, TYPESAFE_DISPATCHER);
      assert.equal(host.services.get("typesafe-api").version, 1);
      assert.equal(host.dispatchDecisions.current.requiresModel, false);
      assert.deepEqual(host.validators.versions(), [{ name: TYPESAFE_VALIDATOR, version: 1, apiVersion: 1 }]);
      assert.deepEqual(host.dispatchDecisions.versions(), [{ name: TYPESAFE_DISPATCHER, version: 1, apiVersion: 1 }]);
      host.validators.select(false); assert.equal(host.validators.current, undefined);
      assert.equal(host.dispatchDecisions.current.name, TYPESAFE_DISPATCHER);
      assert.equal(network.mock.callCount(), 0);
    } finally { await host.stop(); }
  }
  const { TYPESAFE_BANKS, registeredBank } = await import(artifact("builtin-plugins/typesafe-question-banks"));
  assert.ok(Object.isFrozen(TYPESAFE_BANKS));
  assert.deepEqual(Object.keys(TYPESAFE_BANKS).sort(), [COMPLETION_BANK.id, DISPATCH_BANK.id, READY_BANK.id].sort());
  for (const bank of [COMPLETION_BANK, DISPATCH_BANK, READY_BANK]) {
    assert.equal(registeredBank(bank), bank);
    assert.equal(registeredBank({ ...bank, id: bank.id.replace(/_v1$/, "_v999") }), undefined);
    assert.equal(registeredBank({ ...bank, choices: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`choice_${i}`, "too many"])) }), undefined);
    assert.ok(Object.isFrozen(bank)); assert.ok(Object.isFrozen(bank.choices));
    assert.match(bank.id, /_v1$/); assert.ok(Object.keys(bank.choices).length <= 8);
  }
});

test("ready deployment fragment survives real config normalization without granting work or reading credentials", async t => {
  const network = t.mock.method(globalThis, "fetch", () => { throw Error("No network during config binding"); });
  const patch = YAML.parse(await readFile(new URL("../examples/typesafe-decisions.patch.yaml", import.meta.url), "utf8"));
  const { defaultConfig } = await import(artifact("config"));
  const { createTypeSafeAPIPlugin } = await import(artifact("builtin-plugins/typesafe-api-plugin"));
  const config = defaultConfig({ ...patch, home: "/unused" });
  assert.equal(config.typeSafeDecisions.endpoint, "https://gateway.example.invalid/v1/systemone");
  assert.equal(config.typeSafeDecisions.model, "openjev-latest");
  assert.equal(config.typeSafeDecisions.bearerTokenFile, "/run/secrets/typesafe-bearer-token");
  assert.equal(config.completionCheck.provider, "typesafe-completion");
  assert.equal(config.dispatcher.decisionProvider, "typesafe-dispatch");
  assert.equal(config.dispatcher.enabled, false, "binding cannot enable Dispatcher");
  assert.equal(config.completionCheck.authorizations, undefined, "binding cannot create authorization");
  assert.ok(createTypeSafeAPIPlugin(config.typeSafeDecisions));
  assert.equal(network.mock.callCount(), 0);
});
