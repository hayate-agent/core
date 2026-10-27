import type { Inbound } from "./types.js";
import type { AssessmentBackend as ReviewBackend } from "./assessment-backend.js";

export interface CompletionAuthorization {
  /** Trusted caller supplies the existing task boundary; never derive from reply. */
  task: string;
  expiresAt?: number;
}

export type CompletionPrompt = (input: Inbound, reply: string, authorization: CompletionAuthorization, now: () => number) => string;

/** Classifier output is advisory. The caller must recheck cancellation, pause,
 * queue ownership and authorization before committing a continuation.
 */
export async function assessCompletion(backend: ReviewBackend, input: Inbound, reply: string,
  authorization: CompletionAuthorization | undefined, signal: AbortSignal,
  model: string | undefined = undefined, now = Date.now, promptStrategy?: CompletionPrompt): Promise<NonNullable<Inbound["continuation"]> | undefined> {
  if (!promptStrategy) return;
  const checkpoint = input.continuation;
  if (checkpoint?.state === "continue" || input.source === "api" || input.sessionKey === "improvement:nightly" ||
      (input.continuationDepth ?? 0) >= 20 || signal.aborted || !authorization ||
      !authorization.task.trim() || authorization.task.length > 8000 ||
      (authorization.expiresAt !== undefined && (!Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= now()))) return;
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Error("Completion assessment timed out")); }, 10000);
  });
  try {
    const prompt = promptStrategy(input, reply, authorization, now);
    const raw = await Promise.race([backend.review(prompt, model, "low", controller.signal), timeout]);
    if (signal.aborted || controller.signal.aborted || (authorization.expiresAt !== undefined && authorization.expiresAt <= now()) || input.continuation !== checkpoint || raw.length > 8000) return;
    const result = JSON.parse(raw);
    if (result.state !== "continue" || typeof result.next !== "string" || !result.next.trim() || result.next.length > 4000) return;
    return { state: "continue", next: result.next.trim(), ...(authorization.expiresAt !== undefined ? { expiresAt: authorization.expiresAt } : {}) };
  } catch { return undefined; }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
