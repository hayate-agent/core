import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const revision = "a".repeat(40);
async function fixture(metadata: unknown, check: (load: () => Promise<any>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "build-info-types-"));
  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", version: "2.3.4" }));
    await writeFile(path.join(dir, "src/build-info.ts"), await readFile(new URL("../src/build-info.ts", import.meta.url)));
    if (metadata !== undefined) await writeFile(path.join(dir, "build-info.json"), JSON.stringify(metadata));
    await check(() => import(pathToFileURL(path.join(dir, "src/build-info.ts")).href));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
for (const [name, metadata] of [
  ["version array", { version: ["1.2.3"], revision }],
  ["revision array", { version: "1.2.3", revision: [revision] }],
  ["version number", { version: 123, revision }],
  ["version null", { version: null, revision }],
  ["revision object", { version: "1.2.3", revision: {} }],
] as const) {
  test(`build info rejects ${name}`, async () => {
    await fixture(metadata, async load => { await assert.rejects(load, /Invalid build metadata/); });
  });
}
test("build info preserves valid strings", async () => {
  await fixture({ version: "1.2.3", revision }, async load => {
    const mod = await load();
    assert.deepEqual(mod.BUILD_INFO, { version: "1.2.3", revision });
    assert.deepEqual(mod.readBuildInfo(), mod.BUILD_INFO);
  });
});
test("build info preserves missing-file fallback", async () => {
  await fixture(undefined, async load => { assert.deepEqual((await load()).BUILD_INFO, { version: "2.3.4" }); });
});
