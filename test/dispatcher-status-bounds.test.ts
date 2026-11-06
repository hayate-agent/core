// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { dispatcherPlugin } from "../src/builtin-plugins/dispatcher-plugin.js";

test("dispatcher status filters exact ids, pages metadata and retrieves full original fields without authority tokens", async () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: `id-${i}`, requestId: `request-${i}`, parent: "parent", status: "completed", restarts: 0,
    input: "task".repeat(8000), result: "r".repeat(64000), checkpoint: "c".repeat(64000), token: "PRIVATE-CLAIM", dependency: { original: "not a fresh grant" } }));
  let tool: any;
  const plugin = dispatcherPlugin(() => ({ store: { list: (key: string) => key === "parent" ? rows : [] } }) as any);
  await plugin.activate({ registerTool: (value: any) => { tool = value; }, registerCommand: () => {} } as any);
  const run = async (input: any, sessionKey = "parent") => JSON.parse(await tool.execute({ action: "status", ...input }, { sessionKey }));
  const page = await run({});
  assert.equal(page.tasks.length, 10); assert.equal(page.total, 45); assert.equal(page.nextOffset, 10);
  assert.ok(JSON.stringify(page).length < 20000); assert.ok(!JSON.stringify(page).includes("PRIVATE-CLAIM"));
  assert.equal((await run({ id: "id-20" })).tasks[0].id, "id-20");
  assert.equal((await run({ requestId: "request-21" })).tasks[0].id, "id-21");
  assert.equal((await run({ id: "absent" })).total, 0);
  assert.equal((await run({ id: "id-20" }, "foreign")).total, 0);
  assert.equal((await run({ id: "id-20", requestId: "request-21" })).total, 0);
  let value = "", charOffset = 0;
  do { const part = await run({ id: "id-20", field: "result", charOffset }); value += part.text; charOffset = part.nextCharOffset; } while (charOffset !== null);
  assert.equal(value, rows[20].result); assert.equal(rows.length, 45); assert.equal(rows[20].result.length, 64000);
  await assert.rejects(run({ field: "result" })); await assert.rejects(run({ limit: 21 })); await assert.rejects(run({ offset: -1 }));
});
