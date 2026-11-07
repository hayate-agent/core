import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { link, open, readFile, unlink, type FileHandle } from "node:fs/promises";

// Permanent inode: never unlink or replace a published lock while a home is in use.
const MARKER = "hayate-session-lock:flock:v2\n";
const BUSY = "Session or Harness home is already open in another terminal. Use a separate HAYATE_AGENT_HOME for an independent process.";
const LOCK_HELPER = `import errno, fcntl, signal, sys
# Also bound an orphaned acquisition helper when the Node owner has already died.
signal.alarm(10)
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as error:
    if error.errno in (errno.EACCES, errno.EAGAIN):
        sys.exit(73)
    raise
# FD 3 shares the Node owner's open file description. Do not LOCK_UN here:
# closing this inherited descriptor leaves ownership on the owner's retained FD.
`;

/** Process-bound OS advisory ownership, not a PID file, database or lease.
 * The helper only performs flock(2) on an inherited descriptor and exits.
 * The Node process retains the same open file description; close/crash releases it.
 * Requires POSIX flock semantics (Linux/macOS) and Python 3's standard-library fcntl.
 */
export class SessionLock {
  private constructor(private file: FileHandle | undefined) {}

  static async acquire(lock: string): Promise<SessionLock> {
    const temporary = `${lock}.${randomUUID()}.tmp`;
    const staging = await open(temporary, "wx", 0o600);
    try {
      await staging.writeFile(MARKER);
      await staging.sync();
      try { await link(temporary, lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally {
      await staging.close();
      await unlink(temporary);
    }
    if (await readFile(lock, "utf8") !== MARKER) {
      throw Error(`Unsupported or legacy session lock: ${lock}; inspect it manually and perform an offline migration only after all older owners are stopped`);
    }
    const file = await open(lock, "r+");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("python3", ["-I", "-S", "-c", LOCK_HELPER], {
          stdio: ["ignore", "ignore", "pipe", file.fd], timeout: 10000, killSignal: "SIGTERM",
        });
        // Consume, but never surface unbounded environment/helper output.
        child.stderr?.resume();
        child.once("error", () => reject(Error("OS session locking requires Python 3 with fcntl; no fallback is permitted")));
        child.once("close", (code, signal) => {
          if (code === 0) resolve();
          else if (code === 73) reject(Error(BUSY));
          else reject(Error(`OS session lock helper failed (${signal ?? code}); refusing unsafe startup`));
        });
      });
      return new SessionLock(file);
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async release(): Promise<void> {
    const file = this.file;
    if (!file) return;
    this.file = undefined;
    await file.close();
  }
}
