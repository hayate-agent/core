// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startMemoryGuard } from "../src/memguard.js";

for (const gatedReading of [1, 2]) {
  test(`memguard stop prevents a signal after pending pressure reading ${gatedReading}`, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "memguard-stop-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "41"));
    await writeFile(path.join(dir, "41", "statm"), "9999 500 0 0 0 0 0\n");
    await writeFile(path.join(dir, "41", "stat"), `41 (synthetic) S 10 ${Array(17).fill("0").join(" ")} 100 0\n`);
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    let readings = 0;
    const killed: number[] = [];
    t.mock.timers.enable({ apis: ["setInterval"] });
    const stop = startMemoryGuard({
      percent: 90, procDir: dir, root: 10, log: () => {},
      kill: (pid) => { killed.push(pid); },
      usage: async () => {
        if (++readings === gatedReading) { entered(); await gate; }
        return { workingSet: 950, limit: 1000 };
      },
    });
    t.after(stop);
    t.mock.timers.tick(1000);
    await waiting;
    stop(); stop();
    release();
    // Allow the finite local filesystem scan and revalidation to finish. Only interval
    // timers are mocked; this deadline uses a real timer, without starting another check.
    await new Promise((resolve) => setTimeout(resolve, 100));
    t.mock.timers.tick(5000);
    assert.deepEqual(killed, [], "a stopped guard must not signal an in-flight candidate");
    assert.equal(readings, gatedReading, "stop must not start further pressure readings");
  });
}
