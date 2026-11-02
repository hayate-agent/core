import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

// Permanent protocol marker: old PID-only clients reject this rather than taking
// ownership. Neither this file nor the database may be unlinked/replaced while
// the home is in use (including by maintenance tooling).
const MARKER = "vanillacore-session-lock:sqlite-exclusive:v1\n";
const BUSY = "Session or Harness home is already open in another terminal. Use a separate HAYATE_AGENT_HOME for an independent process.";

/**
 * Kernel-owned, not PID-owned. SQLite's rollback-journal locking coordinates
 * processes and hosts on a filesystem with working POSIX advisory locks. A
 * process exit/SIGKILL drops ownership, including across PID namespaces/reuse.
 *
 * Keep the inode permanent: unlink/recreate and check-then-unlink stale-lock
 * recovery can split contenders across different inodes. No stale reaper,
 * heartbeat, hostname, /proc lookup or namespace-dependent liveness probe is used.
 * Unsupported/broken network-filesystem locking is NOT safe; the same local/PVC
 * filesystem must support SQLite rollback-journal locking for every writer.
 */
export class SessionLock {
  private constructor(private database: DatabaseSync | undefined) {}

  static async acquire(lock: string): Promise<SessionLock> {
    // Publish only a complete marker, atomically, without replacing a predecessor.
    // A crash before link leaves an inert temp file; after link the marker is
    // already valid and another process can acquire the kernel lock safely.
    const temporary = `${lock}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(MARKER);
      await file.sync();
      try { await link(temporary, lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally {
      await file.close();
      await unlink(temporary);
    }
    if (await readFile(lock, "utf8") !== MARKER) {
      // Even a dead legacy PID is ambiguous across hosts/namespaces. Never
      // migrate it automatically or silently erase the operator's evidence.
      throw Error(`Invalid or legacy session lock: ${lock}; inspect it manually after confirming all owners are stopped`);
    }

    let database: DatabaseSync | undefined;
    try {
      // SQLite must retain ownership of this connection for the entire session.
      // No timeout/lease: contention fails immediately, never steals a live lock.
      database = new DatabaseSync(`${lock}.sqlite`);
      database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;");
      return new SessionLock(database);
    } catch (error) {
      database?.close();
      if ((error as { errcode?: number }).errcode === 5 || (error as { errcode?: number }).errcode === 6) throw Error(BUSY);
      throw error;
    }
  }

  async release(): Promise<void> {
    const database = this.database;
    if (!database) return;
    // close rolls back the uncommitted transaction and releases the OS lock.
    // Never unlink anything: repeated/late release cannot remove a successor.
    database.close();
    this.database = undefined;
  }
}
