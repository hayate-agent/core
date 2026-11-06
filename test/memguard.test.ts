// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { largestChild, readUsage, startMemoryGuard } from "../src/memguard.js";

async function fakeHost(current: number, max: string, inactive: number, procs: Record<number, [number, number, string, string?]>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memguard-"));
  const cg = path.join(root, "cg");
  await mkdir(cg);
  await writeFile(path.join(cg, "memory.max"), `${max}\n`);
  await writeFile(path.join(cg, "memory.current"), `${current}\n`);
  await writeFile(path.join(cg, "memory.stat"), `anon 1\ninactive_file ${inactive}\nactive_file 5\n`);
  for (const [pid, [ppid, pages, comm, start = "100"]] of Object.entries(procs)) {
    const d = path.join(root, "proc", pid);
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "statm"), `9999 ${pages} 0 0 0 0 0\n`);
    await writeFile(path.join(d, "stat"), `${pid} (${comm}) S ${ppid} ${Array(17).fill("0").join(" ")} ${start} 0\n`);
  }
  return { cg, proc: path.join(root, "proc") };
}

test("memguard: working set excludes inactive file cache; no limit means no guard", async () => {
  const a = await fakeHost(1000, "2000", 300, {});
  assert.deepEqual(await readUsage(a.cg), { workingSet: 700, limit: 2000 });
  const b = await fakeHost(1000, "max", 0, {});
  assert.equal(await readUsage(b.cg), undefined);
});

test("memguard: only descendants of the harness are candidates", async () => {
  // 1 tini -> 10 harness -> 40 bash -> 41 node (tsc); 50 is an unrelated, larger sibling.
  const h = await fakeHost(0, "1", 0, {
    1: [0, 900000, "tini"],
    10: [1, 800000, "node"],
    40: [10, 10, "bash"],
    41: [40, 500, "node (tsc) x"],
    50: [1, 700000, "postgres"],
  });
  assert.deepEqual(await largestChild(h.proc, 10), { pid: 41, ppid: 40, start: "100", rss: 500 * 4096, comm: "node (tsc) x" });
  assert.equal(await largestChild(h.proc, 99), undefined);
});

test("memguard: kills the largest child above the threshold only", async () => {
  const procs = { 10: [1, 9000, "node"], 41: [10, 500, "tsc"], 42: [10, 20, "bash"] } as Record<number, [number, number, string, string?]>;
  const below = await fakeHost(850, "1000", 0, procs);
  const above = await fakeHost(950, "1000", 0, procs);
  const killed: number[] = [];
  const logs: string[] = [];
  for (const h of [below, above]) {
    const stop = startMemoryGuard({ percent: 90, intervalMs: 5, cgroupDir: h.cg, procDir: h.proc, root: 10, log: (m) => logs.push(m), kill: (p) => killed.push(p) });
    try {
      if (h === below) await new Promise((r) => setTimeout(r, 40));
      else {
        const deadline = Date.now() + 2000;
        while (!killed.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      }
    } finally { stop(); }
    if (h === below) assert.deepEqual(killed, []);
  }
  assert.ok(killed.length >= 1 && killed.every((p) => p === 41));
  assert.match(logs[0]!, /pid 41 tsc/);
});

test("memguard: no kill when pressure is gone after the victim scan", async () => {
  const h = await fakeHost(0, "1", 0, { 10: [1, 9000, "node"], 41: [10, 500, "tsc"] });
  const killed: number[] = [];
  const readings = [950, 100]; // above before the scan, below right before the signal
  let calls = 0;
  const stop = startMemoryGuard({
    percent: 90,
    intervalMs: 5,
    procDir: h.proc,
    root: 10,
    log: () => {},
    kill: (p) => killed.push(p),
    usage: async () => ({ workingSet: readings[Math.min(calls++, 1)]!, limit: 1000 }),
  });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.ok(calls >= 2);
  assert.deepEqual(killed, []);
});

test("memguard: a reused pid (same parent and name, new start time) is not killed", async () => {
  const h = await fakeHost(950, "1000", 0, { 10: [1, 9000, "node"], 41: [10, 500, "tsc", "100"] });
  const killed: number[] = [];
  let calls = 0;
  const stop = startMemoryGuard({
    percent: 90,
    intervalMs: 5,
    procDir: h.proc,
    root: 10,
    log: () => {},
    kill: () => killed.push(calls), // usage readings so far when the signal is sent
    usage: async () => {
      // Second reading happens after the scan: replace pid 41 by a new process meanwhile.
      if (calls++ === 1) await writeFile(path.join(h.proc, "41", "stat"), `41 (tsc) S 10 ${Array(17).fill("0").join(" ")} 777 0\n`);
      return { workingSet: 950, limit: 1000 };
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  stop();
  // Round 1 (readings 1+2) selected the old process and must not signal the replacement;
  // later rounds legitimately select the new process.
  assert.ok(!killed.includes(2), "first selection must not hit the replacement");
});
