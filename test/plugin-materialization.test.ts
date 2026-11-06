// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);

test("materializer preserves plugin peers and rewrites core static and type imports, verifies before replacing", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-materialize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts")); await mkdir(path.join(root, "source/src"), { recursive: true });
  await copyFile(new URL("../scripts/materialize-plugins.mjs", import.meta.url), path.join(root, "scripts/materialize-plugins.mjs"));
  const sources = {
    "peer.ts": "export const peer = true;\n",
    "entry.ts": `import {peer} from "./peer.js";\nimport type {Address} from './types.js';\ntype Event = import("./activity.js").ActivityEvent;\nexport {peer} from './peer.js';\n`,
  };
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(sources)) { await writeFile(path.join(root, "source/src", name), text); files[name] = createHash("sha256").update(text).digest("hex"); }
  await writeFile(path.join(root, "plugins.lock.json"), JSON.stringify({ schema: 1, repository: "https://git.vanillacore.net/harness/plugins", revision: "a".repeat(40), files }));
  await exec(process.execPath, [path.join(root, "scripts/materialize-plugins.mjs"), path.join(root, "source")]);
  const output = path.join(root, "src/builtin-plugins/entry.ts"); const text = await readFile(output, "utf8");
  assert.match(text, /from "\.\/peer.js"/); assert.match(text, /from '\.\.\/types.js'/);
  assert.match(text, /import\("\.\.\/activity.js"\)/); assert.match(text, /from '\.\/peer.js'/);
  await writeFile(path.join(root, "source/src/peer.ts"), "tampered");
  await assert.rejects(exec(process.execPath, [path.join(root, "scripts/materialize-plugins.mjs"), path.join(root, "source")]));
  assert.equal(await readFile(output, "utf8"), text);
});

test("bundled gateway catalog resolves plugin-owned factory without configured Matrix", async () => {
  const { bundledGatewayModules } = await import("../src/builtin-plugins/gateway-baselines.js");
  const modules = bundledGatewayModules();
  assert.match(modules.matrix, /builtin-plugins\/matrix-gateway\.(ts|js)$/);
  const factory = (await import(modules.matrix)).default;
  assert.equal(factory.apiVersion, 1);
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.equal(cli.includes("./channels/matrix"), false);
});
