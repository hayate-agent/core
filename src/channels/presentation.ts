export type MessageKind = "user" | "assistant" | "info" | "success" | "error" | "cancelled";
export interface TranscriptEntry { kind: MessageKind; text: string; }

/** Keep terminal control sequences from tool/model text out of the renderer. */
export function plainText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function tint(text: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Roles and outcomes remain distinguishable without color. */
export function renderEntry(entry: TranscriptEntry, color: boolean): string {
  const styles: Record<MessageKind, [string, string]> = {
    user: ["❯", "36"], assistant: ["│", "35"],
    info: ["·", "2"], success: ["✓", "32"],
    error: ["✕", "1;31"], cancelled: ["■", "33"],
  };
  const [marker, code] = styles[entry.kind];
  return plainText(entry.text).split("\n").map((line, index) => {
    const gutter = entry.kind === "assistant" || index === 0 ? marker : " ";
    const body = entry.kind === "user" ? tint(line, "36", color) : line;
    return `${tint(gutter, code, color)} ${body}`;
  }).join("\n");
}
