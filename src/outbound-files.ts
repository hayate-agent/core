import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { writeFileDurable } from "./durable.js";
import type { InboundAttachment } from "./types.js";

export const MAX_OUTBOUND_FILE = 10 * 1024 * 1024;
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
/** Snapshot one explicit, regular workspace file (or this conversation's inbound blob).
 * No symlinks, arbitrary host paths, hidden credential trees or foreign attachments.
 * Contents are data, not instructions. Existing tool/mandate authority still applies. */
export async function stageOutboundFile(home: string, sessionKey: string, cwd: string | undefined, filePath: string, filename?: string): Promise<InboundAttachment> {
  if (!cwd || typeof filePath !== "string" || !filePath.trim() || filePath.length > 4000) throw Error("File send requires an explicit workspace file path");
  const source = path.resolve(cwd, filePath);
  const actual = await realpath(source);
  if (actual !== source) throw Error("File send does not follow symlinks; use a regular workspace file");
  const workspace = await realpath(cwd);
  const agentHome = await realpath(home);
  const owner = createHash("sha256").update(sessionKey).digest("hex");
  const directory = path.join(agentHome, "attachments", owner);
  const ownBlob = inside(directory, actual) && path.dirname(actual) === directory && /^[a-f0-9]{64}$/.test(path.basename(actual));
  const protectedNames = new Set(["attachments", "sessions", "session-archives", "local-sessions", "memory", "memory-pending", "secrets", "credentials", "api-private", "plugins", "overlays"]);
  const relative = path.relative(workspace, actual);
  const workspaceParts = path.relative(agentHome, workspace).split(path.sep);
  // An explicitly bound ordinary workspace may itself live under the private
  // agent home (common on containers). Its siblings and runtime stores stay private.
  const nestedWorkspace = inside(agentHome, workspace) && ["workspace", "workspaces", "work", "projects"].includes(workspaceParts[0]) &&
    !workspaceParts.some(part => part.startsWith(".") || protectedNames.has(part));
  const hidden = (nestedWorkspace ? relative : actual).split(path.sep).some(part => part.startsWith(".") || ["secrets", "credentials", "api-private"].includes(part));
  if (!ownBlob && (!inside(workspace, actual) || (inside(agentHome, actual) && !nestedWorkspace) || hidden)) throw Error("File is outside the exportable workspace or belongs to protected/foreign agent storage");
  const name = filename ?? path.basename(actual);
  if (!name || name.length > 255 || name !== path.basename(name) || /[\x00-\x1f\x7f]/.test(name)) throw Error("Invalid outgoing filename");
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_OUTBOUND_FILE) throw Error("Only regular files up to 10 MiB can be sent");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw Error("Outgoing file changed while reading");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error("Outgoing file changed while reading");
  } finally { await handle.close(); }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (ownBlob && sha256 !== path.basename(actual)) throw Error("Attachment integrity failure");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw Error("Outgoing attachment storage must not be a symlink");
  await writeFileDurable(path.join(directory, sha256), bytes);
  return { sessionKey, sha256, size: bytes.length, name };
}

export async function verifyOutboundFile(home: string, sessionKey: string, ref: InboundAttachment): Promise<void> {
  if (ref.sessionKey !== sessionKey || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > MAX_OUTBOUND_FILE) throw Error("Invalid outbound attachment scope");
  const directory = path.join(await realpath(home), "attachments", createHash("sha256").update(sessionKey).digest("hex"));
  if (await realpath(directory) !== directory) throw Error("Invalid outbound attachment storage");
  const handle = await open(path.join(directory, ref.sha256), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== ref.size) throw Error("Outgoing file size mismatch");
    const bytes = Buffer.alloc(ref.size);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!part.bytesRead) throw Error("Outgoing file truncated");
      offset += part.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw Error("Outgoing file integrity failure");
  } finally { await handle.close(); }
}
