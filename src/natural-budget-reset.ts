/** Deliberately a small, whole-message imperative grammar, not an intent classifier.
 * Quotes, markdown, explanations and pasted transcripts never match. */
export function naturalBudgetReset(text: string): { taskId?: string } | undefined {
  const match = /^(?:reset (?:the )?(?:task |action )?budget|setze (?:das )?(?:aufgaben|aktions)?budget zurück)(?: (?:for task|für aufgabe) (\$?[A-Za-z0-9_-]{1,256}))?(?: (?:and continue|und (?:fahre fort|fortsetzen)))?[.!]?$/iu.exec(text.trim());
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
