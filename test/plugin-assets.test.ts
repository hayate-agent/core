import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const { materializeAssets } = await import("../scripts/materialize-plugin-assets.mjs");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const entry = () => ({ name: "webui", repository: "https://git.vanillacore.net/harness/plugins", revision: "a".repeat(40), source: "webui", files: { "index.mjs": digest("export default {};") } });

test("optional plugin sources are copied inertly after whole-lock verification", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-assets-"));
  try {
    const output = path.join(home, "assets");
    await materializeAssets({ schema: 1, plugins: [entry()] }, output, async () => "export default {};");
    assert.equal(await readFile(path.join(output, "webui/index.mjs"), "utf8"), "export default {};");
    assert.equal(JSON.parse(await readFile(path.join(output, "provenance.json"), "utf8")).plugins[0].revision, "a".repeat(40));
    await assert.rejects(materializeAssets({ schema: 1, plugins: [entry()] }, output, async () => "tampered"), /digest mismatch/);
    assert.equal(await readFile(path.join(output, "webui/index.mjs"), "utf8"), "export default {};");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("optional asset locks refuse traversal, foreign repositories, mutable refs and duplicates", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-assets-"));
  try {
    for (const patch of [{ name: "../escape" }, { repository: "https://evil.example/plugins" }, { revision: "main" }, { source: "../escape" }, { files: { "../outside": digest("x") } }]) {
      let loaded = false;
      await assert.rejects(materializeAssets({ schema: 1, plugins: [{ ...entry(), ...patch }] }, path.join(home, "out"), async () => { loaded = true; return "x"; }));
      assert.equal(loaded, false);
    }
    await assert.rejects(materializeAssets({ schema: 1, plugins: [entry(), entry()] }, path.join(home, "out"), async () => "export default {};"), /identity/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("built optional WebUI package carries source and output integrity without a Node dependency tree", async () => {
  const output = new URL("../dist/optional-plugins/webui/", import.meta.url);
  const provenance = JSON.parse(await readFile(new URL("provenance.json", output), "utf8"));
  assert.equal(provenance.plugin.name, "webui");
  assert.match(provenance.plugin.revision, /^[a-f0-9]{40}$/);
  for (const [file, hash] of Object.entries(provenance.files)) {
    assert.equal(createHash("sha256").update(await readFile(new URL(file, output))).digest("hex"), hash);
  }
  const module = await import(new URL("index.mjs", output).href);
  assert.equal(module.default.apiVersion, 1);
  assert.equal(module.default.updateAdmission, "foreground-owned");
  const instance = await module.default.create({ home: os.tmpdir(), agent: "packaging-test" });
  assert.equal(instance.channel.url, undefined, "Packaged factory creates no listener until host start");
  await assert.rejects(readFile(new URL("node_modules/package.json", output)), { code: "ENOENT" });
});
