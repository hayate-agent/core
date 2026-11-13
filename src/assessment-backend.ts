/** Tool-free model assessment contract, independent of any review policy engine. */
export interface AssessmentBackend {
  /** Queue for host model capacity before starting the provider's execution timer. */
  admit?<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T>;
  review(prompt: string, model: string | undefined, thinking: string, signal?: AbortSignal): Promise<string>;
}
