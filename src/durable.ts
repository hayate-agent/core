import { randomUUID } from "node:crypto";
import { open, rename, unlink, link } from "node:fs/promises";
import path from "node:path";

/**
 * Crash-durable atomic replace: write + fsync a temp file, rename it over the target,
 * fsync the directory. When this resolves the new content survives power loss, so
 * acknowledgements (state inbox before Matrix cursor) keep their order on disk.
 */
export async function writeFileDurable(file: string, data: string | Uint8Array, mode = 0o600,
  beforeCommit?: () => void | Promise<void>, directorySync: (dir: string) => Promise<void> = syncDir,
  onPublished?: () => void): Promise<void> {
  // Each call owns its staging inode, including overlapping replacements of one target.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, "wx", mode);
  try {
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Callers may reject publication after staging is durable. The synchronous
    // guard/rename submission is the commit boundary; later aborts cannot undo it.
    if (beforeCommit) {
      const pending = beforeCommit();
      if (pending) await pending;
    }
    await rename(tmp, file);
    onPublished?.(); // rename succeeded; later sync failure is an uncertain publication
    await directorySync(path.dirname(file));
  } catch (err) {
    // Preserve the write/rename failure if best-effort staging cleanup also fails.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Crash-durable first publication; never overwrite an existing SDK/session file. */
export async function writeFileDurableExclusive(file: string, data: string, beforeCommit?: () => void,
  directorySync: (dir: string) => Promise<void> = syncDir): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, "wx", 0o600);
  try {
    try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
    beforeCommit?.();
    await link(tmp, file);
    await directorySync(path.dirname(file));
  } finally { await unlink(tmp).catch(() => {}); }
}

/** Append a line and fsync the file and its directory entry (dead-letter records). */
export async function appendFileDurable(file: string, data: string, mode = 0o600): Promise<void> {
  const fh = await open(file, "a", mode);
  try {
    await fh.appendFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await syncDir(path.dirname(file)); // a newly created file must survive power loss too
}

/** Authority storage must not acknowledge an unsupported directory fsync. */
export async function syncDirStrict(dir: string): Promise<void> {
  const fh = await open(dir, "r");
  try { await fh.sync(); } finally { await fh.close(); }
}

export async function syncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, "r");
    await fh.sync();
  } catch (err) {
    // Some platforms/filesystems do not support fsync on directories.
    if (!["EISDIR", "EINVAL", "EPERM", "ENOTSUP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    await fh?.close();
  }
}
