import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const { cleanRetiredWebUI } = await import("../scripts/clean-retired-webui.mjs");

test("build removes only the retired generated frontend, preserving separate dashboard and operator files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "retired-webui-"));
  try {
    for (const file of ["optional-plugins/webui/index.mjs", "dist/optional-plugins/webui/provenance.json", "operator/plugins/webui/index.mjs", "webui/server/main.mjs", "dist/other-plugin/index.mjs"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), "retained");
    }
    await cleanRetiredWebUI(root); await cleanRetiredWebUI(root);
    for (const file of ["optional-plugins/webui/index.mjs", "dist/optional-plugins/webui/provenance.json"])
      await assert.rejects(readFile(path.join(root, file)), { code: "ENOENT" });
    for (const file of ["operator/plugins/webui/index.mjs", "webui/server/main.mjs", "dist/other-plugin/index.mjs"])
      assert.equal(await readFile(path.join(root, file), "utf8"), "retained");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current Core never pins, downloads, builds or packages the removed Plugins frontend", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["plugins:assets"], undefined);
  assert.match(pkg.scripts.prebuild, /clean-retired-webui/);
  await assert.rejects(readFile(new URL("../plugin-assets.lock.json", import.meta.url)), { code: "ENOENT" });
  await assert.rejects(readFile(new URL("../dist/optional-plugins/webui/provenance.json", import.meta.url)), { code: "ENOENT" });
  const docker = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.doesNotMatch(docker, /plugin-assets\.lock/);
});
