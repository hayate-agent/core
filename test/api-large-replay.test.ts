import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiChannel } from "../src/api/server.js";
import { RunRegistry, type RunEvent } from "../src/api/runs.js";

for (const count of [0, 1, 2000, 150000]) {
  test(`authenticated SSE preserves ${count} retained replay events`, { timeout: 60000 }, async () => {
    const runs = new RunRegistry("/unused/synthetic-replay.json");
    const run = runs.create({ session_key: "synthetic-replay" });
    const replay = Array.from({ length: count }, (_, i) => ({ seq: i, data: { event: "probe" } }) as RunEvent);
    // Synthetic retained source, real authenticated HTTP route, framing and socket drain.
    runs.subscribe = () => ({ replay, closed: true, unsubscribe() {} });
    const logs: string[] = [];
    const key = ["test", "replay", "key"].join("-");
    const api = new ApiChannel({ key, agent: "probe", runs, port: 0, host: "127.0.0.1", cancel: async () => false, models: async () => [], log: m => { if (!m.startsWith("listening on ")) logs.push(m); } });
    await api.start(async () => {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`http://127.0.0.1:${api.address!.port}/v1/runs/${run.run_id}/events`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      assert.equal(response.status, 200);
      const text = await response.text();
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
      assert.equal(ids.length, count, logs.join("\n"));
      assert.ok(ids.every((id, i) => id === i));
      assert.match(text, /: stream closed/);
      assert.equal(logs.length, 0, logs.join("\n"));
    } finally { clearTimeout(timer); controller.abort(); await api.stop(); }
  });
}
