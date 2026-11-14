import { readFile } from "node:fs/promises";
import { SessionLock } from "./session-lock.js";
import { TaskBookStorage } from "./task-book-storage.js";
import path from "node:path";

/** Offline reclamation. Stop the agent and all diagnostic readers first. The
 * exact normal home lock prevents concurrent production owners from starting. */
export async function reclaimTaskBookOffline(home: string): Promise<number> {
  const lock = await SessionLock.acquire(path.join(home, "local-sessions", "home.lock"));
  try {
    const ledger = path.join(home, "executions.json");
    const root = JSON.parse(await readFile(ledger, "utf8"));
    if (!root.taskBookRef) return 0;
    const storage = new TaskBookStorage(ledger);
    await storage.hydrate(root.taskBookRef);
    return await storage.collectOffline(root.taskBookRef);
  } finally { await lock.release(); }
}
