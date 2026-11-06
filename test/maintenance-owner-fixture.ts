// SPDX-License-Identifier: Apache-2.0
// Local subprocess fixture: real owner lifecycle and transport, deterministic runtime only.
import path from "node:path";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";
import { maintenanceControlPlugin } from "../src/builtin-plugins/maintenance-control-plugin.js";
import { FakeRuntime } from "./fakes.js";

const home = process.argv[2]!;
const key = "mem:owner";
const runtime = new FakeRuntime();
const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
const owner = new Harness({ runtime, tickMs: 60000, contextMaintenance: maintenance });
const host = new PluginHost();
owner.paused = true;
await owner.sessionFor(key);
await host.load([], { home, cwd: home, agent: "test" }, [], [], [maintenanceControlPlugin({
  status: () => maintenance.admissionStatus(key),
  admit: (id, request, version) => maintenance.admit(key, id, request, version),
  cancel: (id, version) => maintenance.cancelAdmission(key, id, version),
  maintain: () => owner.maintainIdle(key),
}, path.join(home, "control"))]);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await host.stop();
  await owner.stop(1000);
  process.disconnect?.();
}
process.on("disconnect", () => { void stop(); });
process.on("message", async command => {
  if (command === "stop") await stop();
  else if (command === "resume") { owner.paused = false; process.send?.({ resumed: true }); }
  else if (command === "metrics") process.send?.({ compacted: runtime.sessions.get(key)!.compacted, opened: runtime.opened.length });
});
process.send?.({ ready: true });
