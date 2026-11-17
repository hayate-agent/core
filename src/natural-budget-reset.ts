/** Deliberately a small, whole-message imperative grammar, not an intent classifier.
 * Quotes, markdown, explanations and pasted transcripts never match. */
export function naturalBudgetReset(text: string): { taskId?: string; simple?: true } | undefined {
  const normalized = text.normalize("NFC").trim().replace(/[ \t]+/g, " ");
  const simple = /^(?:continue|resume|keep going|weiter|weitermachen|fortsetzen|mach weiter|fahre fort|continuar|продолжить)(?: (?:task|aufgabe) (\$?[A-Za-z0-9_-]{1,256}))?[.!]?$/iu.exec(normalized);
  if (simple) return { taskId: simple[1], simple: true };
  const match = /^(?:reset (?:the )?(?:task |action )?budget|setze (?:das )?(?:aufgaben|aktions)?budget zurück)(?: (?:for task|für aufgabe) (\$?[A-Za-z0-9_-]{1,256}))?(?: (?:and continue|und (?:fahre fort|fortsetzen)))?[.!]?$/iu.exec(normalized);
  return match ? { taskId: match[1] } : undefined;
}

/** Only populated by the authenticated command ingress, never from model input. */
export interface OperatorBudgetGrant {
  request: string;
  taskId: string;
  expected: string;
  actor: string;
  issuedAt: number;
  deadline: number;
  reply: { sessionKey: string; replyTo?: import('./types.js').Address };
  result?: string;
  notified?: boolean;
}
