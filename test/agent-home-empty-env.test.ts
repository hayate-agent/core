import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { agentHome, configurationFile } from "../src/product-paths.js";

const root = path.join(path.sep, "synthetic-user-home");
const canonical = path.join(root, ".hayate-agent");

test("an empty or blank HAYATE_AGENT_HOME falls back to the canonical home", () => {
  for (const value of ["", "   ", "\t"]) assert.equal(agentHome(undefined, { HAYATE_AGENT_HOME: value }, root), canonical);
  assert.equal(path.isAbsolute(configurationFile(agentHome(undefined, { HAYATE_AGENT_HOME: "" }, root))), true);
});

test("a non-blank HAYATE_AGENT_HOME and an explicit home are unchanged", () => {
  assert.equal(agentHome(undefined, { HAYATE_AGENT_HOME: "/x/y" }, root), "/x/y");
  assert.equal(agentHome("/e", { HAYATE_AGENT_HOME: "" }, root), "/e");
});
