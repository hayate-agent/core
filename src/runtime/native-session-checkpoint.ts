import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeFileDurableExclusive } from "../durable.js";

/** PI deliberately defers its first JSONL write until a user/assistant message.
 * A handover is a custom_message and therefore can otherwise exist ONLY in RAM,
 * even after the Dispatcher publishes the replacement worker session identity.
 * Publish the exact public SDK snapshot, then re-open it via the PUBLIC SDK API
 * to synchronize its first-write state. Never fake a user/assistant message,
 * change private SDK fields, replace another file, or count a seed as work. */
export async function checkpointNativeSession(manager: SessionManager): Promise<void> {
  const file = manager.getSessionFile?.();
  if (!file) return; // In-memory external providers use their awaited checkpoint.
  const snapshot = () => [manager.getHeader(), ...manager.getEntries()].filter(Boolean).map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const text = snapshot(), leaf = manager.getLeafId();
  const unchanged = () => {
    if (manager.getSessionFile() !== file || manager.getLeafId() !== leaf || snapshot() !== text) throw Error("Native session changed during recovery checkpoint");
  };
  try { await writeFileDurableExclusive(file, text, unchanged); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  // Existing content must be exact, never overwrite a partial/conflicting file
  // or let a retry enter PI's exclusive first-write EEXIST loop.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile() || await handle.readFile("utf8") !== text) throw Error("Native recovery checkpoint conflicts with retained session file");
    await handle.sync();
  } finally { await handle.close(); }
  unchanged();
  manager.setSessionFile(file);
  if (manager.getLeafId() !== leaf) throw Error("Native recovery checkpoint branch changed");
}
