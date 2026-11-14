/** Deterministic logical bytes handed to durable writes, not a timing/live benchmark.
 * Run: node --import tsx scripts/partition-io-evidence.ts
 * Uses real StateStore/ExecutionStore; immutable filenames identify new payloads.
 * Initial migration is explicitly excluded from the incremental measurement. */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore, type PersistedState } from "../src/state.js";
import { ExecutionStore } from "../src/execution.js";

const home = await mkdtemp(path.join(os.tmpdir(), "partition-io-"));
const rows: object[] = [];
try {
  for (const unrelated of [0, 10, 100, 1000]) {
    for (const kind of ["session", "execution"] as const) {
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
        await writeFile(file, JSON.stringify(ledger));
        const store = new ExecutionStore(file); await store.load(); await store.holdLegacyRecovery();
        change = () => store.control("execution-0000", "pause");
        legacyAfter = () => ({ version: 1, executions: store.list(), events: store.events() });
      }
      const before = new Set(await readdir(`${file}.parts`));
      await change();
      const added = (await readdir(`${file}.parts`)).filter(name => !before.has(name));
      const payloadBytes = (await Promise.all(added.map(name => stat(path.join(`${file}.parts`, name))))).reduce((sum, info) => sum + info.size, 0);
      const indexBytes = (await stat(file)).size;
      // Original state used pretty JSON, executions compact JSON.
      const legacyBytes = Buffer.byteLength(`${JSON.stringify(legacyAfter(), null, kind === "session" ? 2 : undefined)}\n`);
      const index = JSON.parse(await readFile(file, "utf8"));
      if (index.format !== "hayate-partitioned-json" || added.length !== (kind === "session" ? 1 : 2)) throw Error("Unexpected write amplification");
      rows.push({ kind, unrelated, legacyBytes, payloadFilesWritten: added.length, payloadBytes, indexBytes, totalBytes: payloadBytes + indexBytes });
    }
  }
  console.log(JSON.stringify({ measurement: "logical durable-write bytes; initial migration excluded; no timing claim", payloadSize: 65536, rows }, null, 2));
} finally { await rm(home, { recursive: true, force: true }); }
