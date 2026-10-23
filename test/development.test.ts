import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { developmentGuide, developmentContext } from "../src/development.js";

test("built-in development instructions resolve independently of current workspace", async () => {
  assert.ok(developmentGuide.endsWith("/docs/development.md"));
  const guide = await readFile(developmentGuide, "utf8");
  assert.match(guide, /src\/channels\/tui.ts/);
  assert.match(guide, /configured local ESM plugins, API v1/);
  assert.match(guide, /npm run typecheck/);
  assert.ok(developmentContext().includes(JSON.stringify(developmentGuide)));
});
