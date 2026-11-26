import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

test("blank HAYATE_AGENT_AGENT falls back to the default agent key", () => {
  for (const v of ["", "   "]) assert.equal(withEnv({ HAYATE_AGENT_AGENT: v }, () => defaultConfig().agent), "agent");
  assert.equal(withEnv({ HAYATE_AGENT_AGENT: "peter" }, () => defaultConfig().agent), "peter");
});

test("blank TZ falls back to the system timezone and stays a valid IANA zone", () => {
  for (const v of ["", "  "]) {
    const tz = withEnv({ TZ: v }, () => defaultConfig().timezone);
    assert.ok(tz.trim().length > 0, `timezone must not be blank, got ${JSON.stringify(tz)}`);
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-GB", { timeZone: tz }));
  }
  assert.equal(withEnv({ TZ: "Europe/Berlin" }, () => defaultConfig().timezone), "Europe/Berlin");
});
