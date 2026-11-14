/** Deterministic logical bytes handed to durable writes, not a timing/live benchmark.
 * Run: node --import tsx scripts/partition-io-evidence.ts
 * Uses real StateStore/ExecutionStore; immutable filenames identify new payloads.
 * Initial migration is explicitly excluded from the incremental measurement. */
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { StateStore, type PersistedState } from "../src/state.js";
import { ExecutionStore } from "../src/execution.js";
import { PartitionedJson } from "../src/partitioned-json.js";

const home = await mkdtemp(path.join(os.tmpdir(), "partition-io-"));
const rows: object[] = [];
async function payloads(dir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else result.set(name, (await stat(path.join(dir, name))).size);
    }
  }
  await walk();
  return result;
}
try {
  for (const unrelated of [0, 10, 100, 1000]) {
    for (const kind of ["session", "execution"] as const) {
      // Progress belongs on stderr: interrupted runs must not look like complete
      // JSON evidence, and per-record durable migration can take substantial IO.
      console.error(`start ${kind} unrelated=${unrelated} (migration excluded from measured bytes)`);
      const file = path.join(home, `${kind}-${unrelated}.json`);
      const text = "x".repeat(64 * 1024);
      let change: () => Promise<void>, legacyAfter: () => unknown;
      if (kind === "session") {
        const live: PersistedState = { version: 1, paused: false, busyMode: "queue", sessions:
          Array.from({ length: unrelated + 1 }, (_, i) => ({ key: `session-${String(i).padStart(4, "0")}`, statusDelivered: { evidence: text }, stopPending: false })) };
        const store = new StateStore(file); await store.save(live);
        change = async () => { live.sessions[0]!.stopPending = true; await store.capture(() => live); };
        legacyAfter = () => live;
      } else {
        const ledger = { version: 1, executions: Array.from({ length: unrelated + 1 }, (_, i) => ({
          id: `execution-${String(i).padStart(4, "0")}`, parent: `session-${String(i).padStart(4, "0")}`, requestId: `request-${i}`,
          input: text, strategy: "direct", strategyVersion: 1, status: "ready", restarts: 0, recoveryEnrollment: "current",
        })), events: [] };
        // Seed the supported previous partition-v1 format. The largest fixture
        // exceeds main's legitimate 32MiB WHOLE-file admission limit; never raise
        // or bypass that production limit to manufacture a legacy migration.
        await new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 }).save(ledger);
        const store = new ExecutionStore(file); await store.load(); await store.holdLegacyRecovery();
        change = () => store.control("execution-0000", "pause");
        legacyAfter = () => ({ version: 1, executions: store.list(), events: store.events() });
      }
      const directory = `${file}.${kind === "session" ? "sessions" : "parts"}`;
      const before = await payloads(directory);
      await change();
      const after = await payloads(directory);
      const added = [...after].filter(([name]) => !before.has(name));
      const payloadBytes = added.reduce((sum, [, size]) => sum + size, 0);
      const indexBytes = (await stat(file)).size;
      // Original state used pretty JSON, executions compact JSON.
      const legacyBytes = Buffer.byteLength(`${JSON.stringify(legacyAfter(), null, kind === "session" ? 2 : undefined)}\n`);
      const index = JSON.parse(await readFile(file, "utf8"));
      if ((kind === "session" ? index.version !== 2 : index.format !== "hayate-partitioned-json") || added.length !== (kind === "session" ? 1 : 2)) throw Error("Unexpected write amplification");
      rows.push({ kind, unrelated, legacyBytes, payloadFilesWritten: added.length, payloadBytes, indexBytes, totalBytes: payloadBytes + indexBytes });
      console.error(`complete ${kind} unrelated=${unrelated}`);
    }
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sourceSha256 = Object.fromEntries(await Promise.all([
    "scripts/partition-io-evidence.ts", "src/state.ts", "src/session-state-storage.ts", "src/partitioned-json.ts", "src/execution.ts", "src/execution-dependency-storage.ts", "src/durable.ts",
  ].map(async file => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
  console.log(JSON.stringify({ measurement: "logical changed-payload + authoritative-index bytes; initial migration excluded; no timing claim",
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), sourceSha256,
    limits: "Eager global load/snapshot/serialization/hashing and linear authoritative index remain. Counts exclude filesystem metadata/journaling and fsync operations. No model-context inference from storage IO.",
    payloadSize: 65536, rows }, null, 2));
} finally { await rm(home, { recursive: true, force: true }); }
