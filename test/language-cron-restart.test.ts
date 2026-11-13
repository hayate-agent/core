import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { Scheduler } from "../src/scheduler.js";
import { cronReportPlugin } from "../src/builtin-plugins/cron-report-plugin.js";
import { CronReports } from "../src/builtin-plugins/cron-reports.js";
import { resolveLanguage } from "../src/language.js";
import { FakeRuntime } from "./fakes.js";
import type { Inbound } from "../src/types.js";
import type { PluginAPI } from "../src/plugins.js";
import type { ReportProcessing } from "../src/report-processing.js";

test("pending cron occurrence keeps admitted language across disk/restart, archive and analysis; legacy reports stay English", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cron-language-restart-"));
  let language = "es"; const pending: Inbound[] = [];
  const ingress = { withForegroundWork: (work: () => Promise<void>) => work(), accept: async (input: Inbound) => { pending.push(input); } } as unknown as Harness;
  await new Scheduler(ingress, { timezone: "UTC", language: () => language }).runJob({ name: "weather", schedule: "0 * * * *", prompt: "Inspect weather", audience: "agent" });
  await writeFile(path.join(home, "inbox.json"), JSON.stringify(pending));
  language = "de";
  let provider!: ReportProcessing; const analysisPrompts: string[] = [];
  cronReportPlugin({ home, backend: { analyze: async prompt => { analysisPrompts.push(prompt); return JSON.stringify({ summary: "summary", actions: [] }); } }, dispatch: async () => { throw Error("No follow-up authorized"); } }).activate({
    services: { get: () => ({ version: 1, implementation: { resolve: (scope: Parameters<typeof resolveLanguage>[1]) => resolveLanguage({ system: language }, scope) } }) },
    registerReportProcessing: (_name: string, processing: ReportProcessing) => { provider = processing; },
  } as unknown as PluginAPI);
  const runtime = new FakeRuntime(() => "Weather observation"), harness = new Harness({ runtime, language: () => ({ system: language }), tickMs: 60000,
    reportOutput: (input, output) => provider.record(input, output), log: () => {} });
  harness.onStateChange = async () => {};
  try {
    harness.restorePending(JSON.parse(await readFile(path.join(home, "inbox.json"), "utf8")));
    await harness.start(); harness.releaseRestored(); await harness.drained();
    assert.match(runtime.sessions.get("cron:weather")!.options[0].instructions!, /output in es/);
    const reports = new CronReports(path.join(home, "cron", "reports"));
    assert.equal((await reports.all())[0].language, "es");
    await reports.record({ job: "legacy", runId: "legacy1", audience: "agent", createdAt: 1, original: "Old report", output: "Observation", maxTasks: 0 });
    await provider.tick?.();
    assert.equal(analysisPrompts.length, 2);
    assert.ok(analysisPrompts.some(p => /prose in es/.test(p)));
    assert.ok(analysisPrompts.some(p => /prose in en/.test(p)));
    for (const p of analysisPrompts) assert.match(p, /JSON keys\/disposition enums remain unchanged/);
  } finally { await harness.stop(0); await provider.stop?.(); await rm(home, { recursive: true, force: true }); }
});
