import { createHash } from "node:crypto";

export const READ_RANGE_CODEPOINTS = 3000;
const MAX_RANGE_RESULT_CHARS = 12000; // Includes a possibly long source path and Unicode pairs.
export const readResultHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Host metadata, never a marker parsed from untrusted file/prose. Persisted with
 * the native result so reopening a session does not require reading a changed file. */
export function boundedReadDetails(text: string) {
  return { hayateReadRange: { version: 1, resultHash: readResultHash(text) } };
}

export function isBoundedReadResult(message: { toolName?: string; isError?: boolean; content?: unknown; details?: unknown }): boolean {
  if (message.toolName !== "read" || message.isError || !Array.isArray(message.content) || message.content.length !== 1) return false;
  const part = message.content[0];
  if (part?.type !== "text" || typeof part.text !== "string" || part.text.length > MAX_RANGE_RESULT_CHARS) return false;
  const receipt = (message.details as ReturnType<typeof boundedReadDetails> | undefined)?.hayateReadRange;
  return receipt?.version === 1 && receipt.resultHash === readResultHash(part.text);
}
