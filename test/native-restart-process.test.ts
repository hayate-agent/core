import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
for (const entry of ["dist/cli.js", "dist/launcher.js"]) test(`${entry}: real /restart closes a hung plugin within shared deadline, then boots a replacement`, { timeout: 45_000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-rst-"));
  const stdout: string[] = [], stderr: string[] = [];
  await writeFile(path.join(home, "hung-plugin.mjs"), "export default {apiVersion:1,activate(api){api.onStop(()=>new Promise(()=>{}));}};");
  await writeFile(path.join(home, "hayate-agent.yaml"), JSON.stringify({ agent: "restart-process-fixture",
    softwareUpdates: { enabled: false }, lifecycle: { restartTimeoutSeconds: 2 }, loop: { drainSeconds: 60 },
    memory: { enabled: false }, dispatcher: { enabled: false }, mcp: { enabled: false }, plugins: ["hung-plugin.mjs"] }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("API_SERVER_") &&
    !key.startsWith("MATRIX_") && !key.startsWith("SLACK_") && !key.startsWith("HAYATE_AGENT_") && !key.startsWith("HERMES_")));
  Object.assign(env, { HOME: home, HAYATE_AGENT_HOME: home, API_SERVER_HOST: "127.0.0.1", API_SERVER_PORT: "0", API_SERVER_KEY: "restart-process-test-key" });
  const child = spawn(process.execPath, ["--import", "tsx", entry, "run", "--home", home, "--console"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", value => stdout.push(String(value))); child.stderr.on("data", value => stderr.push(String(value)));
  const ended = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  const listeners = () => [...stderr.join("").matchAll(/listening on 127\.0\.0\.1:(\d+)/g)].map(m => m[1]);
  const waitFor = async (condition: () => boolean) => {
    for (let n = 0; n < 600 && child.exitCode === null && !condition(); n++) await delay(25);
    assert.ok(condition(), `runtime did not reach expected state: ${stderr.join("").slice(-2000)}`);
  };
  try {
    await waitFor(() => listeners().length >= 1 && stdout.join("").includes("Gestartet und bereit."));
    assert.doesNotMatch(stdout.join(""), /Neustart abgeschlossen/);
    const oldPort = listeners()[0];
    const began = Date.now();
    child.stdin.write("/restart\n");
    await waitFor(() => listeners().length >= 2 && stdout.join("").includes("Neustart abgeschlossen – wieder bereit."));
    assert.equal([...stdout.join("").matchAll(/Neustart abgeschlossen – wieder bereit\./g)].length, 1);
    assert.match(stdout.join(""), /Softwarestand:/);
    assert.equal(child.exitCode, null, "foreground owner must survive its runtime restart");
    assert.match(stdout.join(""), /Restarting: new input is fenced/);
    assert.ok(Date.now() - began < 10_000, "restart must not wait for the never-resolving plugin cleanup or the 60s drain");
    await assert.rejects(fetch(`http://127.0.0.1:${oldPort}/health`, { signal: AbortSignal.timeout(500) }));
    const port = listeners().at(-1);
    const caps = await (await fetch(`http://127.0.0.1:${port}/v1/capabilities`, {
      headers: { Authorization: "Bearer restart-process-test-key" }, signal: AbortSignal.timeout(2000) })).json();
    assert.equal(caps.agent, "restart-process-fixture"); assert.equal(caps.features.durable_shutdown, true);
    assert.equal(caps.lifecycle.restart_timeout_seconds, 2); assert.equal(caps.features.native_software_updates, false);
  } finally {
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("native restart fixture failed to shut down gracefully")), 8000); })]); }
    finally { clearTimeout(timer); }
    await rm(home, { recursive: true, force: true });
  }
});
