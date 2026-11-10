/** Settings for the model benchmark subsystem. Absent block means "not enabled". */
export interface BenchmarkConfig {
  enabled: boolean;
  /**
   * Active benchmark worker slots. Deliberately one by default: these runs
   * measure a single shared GPU, and two concurrent workers make both slower,
   * which is exactly the number a benchmark is supposed to report.
   */
  capacity: number;
  /** Default repetitions per case; comparability comes from medians, not single runs. */
  repeats: number;
  /** Wall-clock budget for one case run before it is recorded as timed out. */
  caseTimeoutMs: number;
  /** Absolute override for the run record directory; defaults below the harness home. */
  runsDir?: string;
}

export const benchmarkConfigDefaults: BenchmarkConfig = { enabled: false, capacity: 1, repeats: 3, caseTimeoutMs: 900_000 };

export function benchmarkConfig(value?: Partial<BenchmarkConfig>): BenchmarkConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw Error("Invalid benchmark configuration");
  const config = { ...benchmarkConfigDefaults, ...value };
  if (typeof config.enabled !== "boolean"
    || !Number.isSafeInteger(config.capacity) || config.capacity < 1 || config.capacity > 4
    || !Number.isSafeInteger(config.repeats) || config.repeats < 1 || config.repeats > 20
    || !Number.isSafeInteger(config.caseTimeoutMs) || config.caseTimeoutMs < 60_000 || config.caseTimeoutMs > 6 * 3_600_000
    || (config.runsDir !== undefined && (typeof config.runsDir !== "string" || !config.runsDir.startsWith("/")))) throw Error("Invalid benchmark configuration");
  return config;
}
