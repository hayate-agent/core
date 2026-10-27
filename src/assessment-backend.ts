/** Tool-free model assessment contract, independent of any review policy engine. */
export interface AssessmentBackend {
  review(prompt: string, model: string | undefined, thinking: string, signal?: AbortSignal): Promise<string>;
}
