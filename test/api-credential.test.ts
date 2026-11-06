// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, readFile, writeFile, lstat, symlink, link, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveApiKey } from "../src/api/credential.js";
import { ApiChannel } from "../src/api/server.js";
import { RunRegistry } from "../src/api/runs.js";

async function fixture(fn: (home: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "api-credential-"));
  const env = { API_SERVER_HOST: "127.0.0.1", API_SERVER_KEY_FILE: path.join(home, "api-private", "key") };
  try { await fn(home, env); } finally { await rm(home, { recursive: true, force: true }); }
}

test("legacy mode remains opt-in and compatible", async () => {
  assert.equal(await resolveApiKey("/unused", {}), undefined);
  assert.equal(await resolveApiKey("/unused", { API_SERVER_KEY: " key " }), "key");
});
test("atomic private generation survives restart without rotation or leftovers", () => fixture(async (home, env) => {
  const key = await resolveApiKey(home, env);
  assert.match(key!, /^[a-f0-9]{64}$/);
  assert.equal(await resolveApiKey(home, env), key);
  assert.equal(await readFile(env.API_SERVER_KEY_FILE!, "utf8"), `${key}\n`);
  assert.equal((await lstat(env.API_SERVER_KEY_FILE!)).mode & 0o7777, 0o600);
  assert.equal((await lstat(path.dirname(env.API_SERVER_KEY_FILE!))).mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(path.dirname(env.API_SERVER_KEY_FILE!)), ["key"]);
}));
test("unsafe configuration never provisions a file", () => fixture(async (home, env) => {
  for (const extra of [{ API_SERVER_HOST: "0.0.0.0" }, { API_SERVER_HOST: "localhost" },
    { API_SERVER_HOST: "::1" }, { API_SERVER_HOST: undefined }, { API_SERVER_KEY: "" },
    { API_SERVER_KEY_FILE: "/tmp/elsewhere" }, { API_SERVER_KEY_FILE: "relative" }, { API_SERVER_KEY_FILE: "" }]) {
    await assert.rejects(resolveApiKey(home, { ...env, ...extra }), /Unsafe API/);
  }
  assert.deepEqual(await readdir(home), []);
}));
test("unsafe existing directory rejected, not silently repaired", () => fixture(async (home, env) => {
  await mkdir(path.dirname(env.API_SERVER_KEY_FILE!), { mode: 0o755 });
  await assert.rejects(resolveApiKey(home, env), /Unsafe API/);
}));
test("symlink directory rejected", () => fixture(async (home, env) => {
  await mkdir(path.join(home, "elsewhere"));
  await symlink(path.join(home, "elsewhere"), path.dirname(env.API_SERVER_KEY_FILE!));
  await assert.rejects(resolveApiKey(home, env), /Unsafe API/);
}));
test("corrupt, oversized, permissive and linked keys fail closed without rotation or key disclosure", () => fixture(async (home, env) => {
  const file = env.API_SERVER_KEY_FILE!;
  const key = await resolveApiKey(home, env);
  await chmod(file, 0o644);
  await assert.rejects(resolveApiKey(home, env), /Unsafe API/);
  await chmod(file, 0o600);
  for (const value of ["", "bad-secret", "x".repeat(100_000), `${"G".repeat(64)}\n`]) {
    await writeFile(file, value);
    await assert.rejects(resolveApiKey(home, env), e => e instanceof Error && e.message === "Unsafe API credential configuration or storage");
    assert.equal(await readFile(file, "utf8"), value);
  }
  await writeFile(file, `${key}\n`);
  await link(file, path.join(home, "hardlink"));
  await assert.rejects(resolveApiKey(home, env), /Unsafe API/);
  await rm(file);
  await symlink(path.join(home, "hardlink"), file);
  await assert.rejects(resolveApiKey(home, env), /Unsafe API/);
}));
test("private file key authenticates the actual API channel after restart", () => fixture(async (home, env) => {
  await resolveApiKey(home, env);
  const api = new ApiChannel({ key: (await resolveApiKey(home, env))!, host: "127.0.0.1", port: 0,
    agent: "example-agent", runs: new RunRegistry(path.join(home, "runs.json")),
    cancel: async () => false, models: async () => [], defaultModel: () => "test/model", log: () => {} });
  await api.start(async () => {});
  try {
    const url = `http://127.0.0.1:${api.address!.port}/v1/capabilities`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer incorrect" } })).status, 401);
    const privateKey = (await readFile(env.API_SERVER_KEY_FILE!, "utf8")).trim();
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${privateKey}` } })).status, 200);
  } finally { await api.stop(); }
}));

test("orphan temporary file from interrupted startup is not used as the credential", () => fixture(async (home, env) => {
  const dir = path.dirname(env.API_SERVER_KEY_FILE!);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(dir, ".key-interrupted"), "incomplete", { mode: 0o600 });
  assert.match((await resolveApiKey(home, env))!, /^[a-f0-9]{64}$/);
}));
