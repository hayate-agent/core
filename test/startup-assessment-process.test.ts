import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

for (const entry of ["dist/cli.js", "dist/launcher.js"]) test(`${entry}: real startup readiness does not wait for external retained-task judgments`, { timeout: 45000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-startup-judge-"));
  const marker = path.join(home, "assessment-entered");
  await writeFile(path.join(home, "slow-provider.mjs"), `import{writeFile}from'node:fs/promises';export default{apiVersion:1,activate(api){api.registerValidatorProvider({apiVersion:1,name:'slow-fixture',version:1,requiresModel:false,async assess(request){await writeFile(${JSON.stringify(marker)},'entered');return new Promise(resolve=>request.signal.addEventListener('abort',()=>resolve(undefined),{once:true}));}});}};`);
  await writeFile(path.join(home, "hayate-agent.yaml"), JSON.stringify({ agent: "startup-judge-fixture", softwareUpdates: { enabled: false },
    lifecycle: { restartTimeoutSeconds: 2 }, loop: { drainSeconds: 1 }, completionCheck: { provider: "slow-fixture", timeoutMs: 120000 },
    memory: { enabled: false }, dispatcher: { enabled: false }, mcp: { enabled: false }, plugins: ["slow-provider.mjs"] }));
  await writeFile(path.join(home, "state.json"), JSON.stringify({ version: 1, paused: false, busyMode: "queue", sessions: [{ key: "api:retained-business-task",
    tasks: [{ id: "original-task", original: "Inspect the existing isolated fixture only, no repeated effects", state: "active", recoveryEnrollment: "current", depth: 3, lastReply: "Retained report requiring independent judgment" }] }] }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_SERVER_|MATRIX_|SLACK_|HAYATE_AGENT_|HERMES_)/.test(key)));
  Object.assign(env, { HOME: home, HAYATE_AGENT_HOME: home, API_SERVER_HOST: "127.0.0.1", API_SERVER_PORT: "0", API_SERVER_KEY: "isolated-startup-judgment-test" });
  const child = spawn(process.execPath, ["--import", "tsx", entry, "run", "--home", home, "--console"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = ""; child.stdout.on("data", x => { output += x; }); child.stderr.on("data", x => { errors += x; });
  const ended = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  try {
    let entered = false;
    for (let i = 0; i < 600 && child.exitCode === null; i++) {
      try { await access(marker); entered = true; } catch {}
      if (entered && /ready again|Started and ready/.test(output)) break;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(entered, true, `Retained assessment was not started: ${errors.slice(-1500)}`);
    assert.match(output, /ready again|Started and ready/, "A pending external judgment must not withhold structural startup readiness");
    assert.equal(child.exitCode, null);
    const port = [...errors.matchAll(/listening on 127\.0\.0\.1:(\d+)/g)].at(-1)?.[1]; assert.ok(port);
    const result = await fetch(`http://127.0.0.1:${port}/v1/capabilities`, { headers: { Authorization: "Bearer isolated-startup-judgment-test" }, signal: AbortSignal.timeout(2000) });
    assert.equal(result.status, 200); assert.equal((await result.json()).agent, "startup-judge-fixture");
  } finally {
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Graceful shutdown did not cancel the retained assessor")), 8000); })]); }
    finally { clearTimeout(timer); }
    await rm(home, { recursive: true, force: true });
  }
});
