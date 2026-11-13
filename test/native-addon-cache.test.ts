import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { restoreVerifiedMatrixAddon } from "../src/native-addon-cache.js";
const relative = "node_modules/@matrix-org/matrix-sdk-crypto-nodejs";
const file = "matrix-sdk-crypto.linux-x64-gnu.node";
const supported = process.platform === "linux" && process.arch === "x64" && !!(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;

test("native cache refuses corrupt bytes, incompatible versions and unknown packages without touching target", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-cache-")); t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target"), source = path.join(root, "source");
  for (const core of [target, source]) { await mkdir(path.join(core, relative), { recursive: true }); await writeFile(path.join(core, relative, "package.json"), '{"version":"0.4.0"}'); }
  await writeFile(path.join(source, relative, file), "not a release binary".repeat(500)); await writeFile(path.join(target, relative, file), "untouched");
  assert.equal(await restoreVerifiedMatrixAddon(target, [source]), false); assert.equal(await readFile(path.join(target, relative, file), "utf8"), "untouched");
  await writeFile(path.join(target, relative, "package.json"), '{"version":"99.0.0"}'); assert.equal(await restoreVerifiedMatrixAddon(target, [source]), false);
  assert.equal(await restoreVerifiedMatrixAddon(path.join(root, "missing"), [source]), false);
});

test("native cache reuses only the exact release checksum and repairs corrupt private staging without changing source", { skip: !supported }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-cache-good-")); t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target"); await mkdir(path.join(target, relative), { recursive: true }); await writeFile(path.join(target, relative, "package.json"), '{"version":"0.4.0"}');
  await writeFile(path.join(target, relative, file), "bad CDN response");
  const core = fileURLToPath(new URL("../", import.meta.url));
  const source = await readFile(path.join(core, relative, file)); const hash = createHash("sha256").update(source).digest("hex");
  assert.equal(hash, "7078d4dd987128f79afd192c4f621f64adece37e43f2a8756f1d0a9f034de718");
  assert.equal(await restoreVerifiedMatrixAddon(target, [path.join(root, "missing"), core]), true);
  assert.equal(createHash("sha256").update(await readFile(path.join(target, relative, file))).digest("hex"), hash);
  assert.equal(createHash("sha256").update(await readFile(path.join(core, relative, file))).digest("hex"), hash);
});
