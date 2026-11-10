/** Persisted assessment attempts back off from one minute to one hour.
 * No inference is needed to compute eligibility and there is no attempt ceiling.
 * This schedules read-only assessment, never authorization to replay effects. */
export function assessmentRetryDelay(attempts: number): number {
  return Math.min(3_600_000, 60_000 * 2 ** Math.min(6, Math.max(0, attempts - 1)));
}
