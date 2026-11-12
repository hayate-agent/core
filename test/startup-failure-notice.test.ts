import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("failed channel startup never emits a ready/restarted notice", { timeout: 25000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "failed-start-notice-"));
  await writeFile(path.join(home, "failed-gateway.mjs"), `export default {apiVersion:1,activate(api){api.registerChannel({name:'offline',async start(){throw Error('fixture gateway unavailable')},async send(){throw Error('must not send')},async stop(){}})}};`);
  await writeFile(path.join(home, "hayate-agent.yaml"), JSON.stringify({ agent: "failed-start-fixture", softwareUpdates: { enabled: false },
    memory: { enabled: false }, dispatcher: { enabled: false }, mcp: { enabled: false }, plugins: ["failed-gateway.mjs"] }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_SERVER_|MATRIX_|SLACK_|HAYATE_AGENT_|HERMES_)/.test(key)));
  Object.assign(env, { HOME: home, HAYATE_AGENT_HOME: home });
  const child = spawn(process.execPath, ["dist/cli.js", "run", "--home", home, "--console"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGTERM"); reject(Error("failed startup did not exit")); }, 20000); })]);
    assert.equal(code, 1); assert.match(output, /fixture gateway unavailable/);
    assert.doesNotMatch(output, /Neustart abgeschlossen|Gestartet und bereit|Softwarestand:/);
  } finally { clearTimeout(timer); await rm(home, { recursive: true, force: true }); }
});
