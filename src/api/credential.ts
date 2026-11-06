import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

const invalid = () => new Error("Unsafe API credential configuration or storage");

/** Opt-in local credential. Caller must hold the exclusive Harness home lock. */
export async function resolveApiKey(home: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.API_SERVER_KEY_FILE === undefined) return env.API_SERVER_KEY?.trim() || undefined;
  const file: string = env.API_SERVER_KEY_FILE;
  // This mode intentionally cannot expose a generated key on a non-loopback listener.
  if (env.API_SERVER_KEY !== undefined || env.API_SERVER_HOST !== "127.0.0.1" ||
      !path.isAbsolute(file) || file !== path.join(path.resolve(home), "api-private", "key")) throw invalid();
  const directory = path.dirname(file);
  try {
    await mkdir(directory, { mode: 0o700 });
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.chmod(0o700); } finally { await handle.close(); }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalid(); }
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o7777) !== 0o700) throw invalid();

  async function readKey(): Promise<string> {
    // O_NONBLOCK avoids hanging on a malicious FIFO; O_NOFOLLOW rejects symlinks.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 ||
          stat.nlink !== 1 || stat.size !== 65) throw invalid();
      const key = await handle.readFile("utf8");
      if (!/^[a-f0-9]{64}\n$/.test(key)) throw invalid();
      return key.trim();
    } finally { await handle.close(); }
  }

  try { return await readKey(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid(); }
  // The home lock serializes startup. Atomic rename publishes only fully written,
  // fsynced data, with no crash window containing a partial key or extra hardlink.
  const temporary = path.join(directory, `.key-${randomBytes(16).toString("hex")}`);
  let created = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      await handle.writeFile(`${randomBytes(32).toString("hex")}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
    created = false;
    const dirHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    return await readKey();
  } catch { throw invalid(); }
  finally { if (created) await unlink(temporary).catch(() => {}); }
}
