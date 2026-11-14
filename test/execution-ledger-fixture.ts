import { PartitionedJson } from "../src/partitioned-json.js";
import { ExecutionDependencyStorage } from "../src/execution-dependency-storage.js";

/** Decode a stopped test ledger before simulating an older on-disk release.
 * Keep all ledger fields and hydrate dependencies, not only the public list API.
 * This is fixture manipulation, never a live-ledger maintenance path. */
export async function readExecutionLedgerFixture(file: string): Promise<any> {
  const ledger = await new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 }).load();
  if (!ledger) throw Error("Missing execution ledger fixture");
  return ledger.version === 2
    ? { ...ledger, version: 1, executions: await new ExecutionDependencyStorage(file).hydrate(ledger.executions as unknown[]) }
    : ledger;
}
