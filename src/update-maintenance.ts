import { readFile } from "node:fs/promises";
import { writeFileDurable } from "./durable.js";

export interface MaintenanceReceipt {
  requestId: string;
  leaseId: string;
  phase: "preparing" | "checkpointed" | "released" | "failed" | "recovered";
  at: number;
  pid: number;
}

/** Admission journal, not an installer. Never replays install/restart/external effects.
 * The deployment owner still owns install rollback and running-version verification.
 * Store beside state.json under the same exclusive host ownership lock. */
export class MaintenanceJournal {
  private receipts: MaintenanceReceipt[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}
  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.receipts) || data.receipts.length > 64 ||
          data.receipts.some((r: MaintenanceReceipt) => !r || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.requestId) ||
            typeof r.leaseId !== "string" || !r.leaseId || !["preparing", "checkpointed", "released", "failed", "recovered"].includes(r.phase) ||
            !Number.isSafeInteger(r.at) || !Number.isSafeInteger(r.pid)) ||
          new Set(data.receipts.map((r: MaintenanceReceipt) => r.requestId)).size !== data.receipts.length)
        throw Error("Invalid maintenance journal; reconcile before admitting updates");
      this.receipts = data.receipts;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  get(requestId: string): MaintenanceReceipt | undefined {
    const receipt = this.receipts.find(r => r.requestId === requestId);
    return receipt && structuredClone(receipt);
  }
  record(receipt: MaintenanceReceipt): Promise<void> {
    const run = this.serial.catch(() => {}).then(async () => {
      const previous = this.get(receipt.requestId);
      if (previous && (previous.leaseId !== receipt.leaseId ||
          !({ preparing: ["checkpointed", "failed", "recovered"], checkpointed: ["released", "recovered"],
            released: [], failed: [], recovered: [] }[previous.phase] as string[]).includes(receipt.phase)))
        throw Error("Stale maintenance receipt");
      const next = this.receipts.filter(r => r.requestId !== receipt.requestId);
      next.push(structuredClone(receipt));
      // Bounded retention is explicit; never evict the currently open transaction.
      while (next.length > 64) {
        const index = next.findIndex(r => ["released", "failed", "recovered"].includes(r.phase));
        if (index < 0) throw Error("Maintenance journal full; reconcile open transactions");
        next.splice(index, 1);
      }
      await writeFileDurable(this.file, JSON.stringify({ version: 1, receipts: next }) + "\n");
      this.receipts = next;
    });
    this.serial = run;
    return run;
  }
  /** Boot acknowledges loss of the old process-local lease; never re-installs or
   * renews task budgets. Task/worker recovery remains owned by the existing ledgers. */
  async recover(): Promise<void> {
    for (const receipt of [...this.receipts]) if (["preparing", "checkpointed"].includes(receipt.phase))
      await this.record({ ...receipt, phase: "recovered", at: Date.now(), pid: process.pid });
  }
}
