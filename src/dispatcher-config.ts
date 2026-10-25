export interface DispatcherConfig {
  enabled: boolean;
  strategy: string;
  /** Explicit operator declaration: the configured runtime/backend supports concurrency. */
  concurrentRequests: boolean;
  /** Active slots, not a limit on the number of persistent workers/tasks. */
  capacity: number;
  /** Automatic archive age for delivered terminal task records. */
  retentionDays: number;
}
export function dispatcherConfig(value?: Partial<DispatcherConfig>): DispatcherConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw Error("Invalid dispatcher configuration");
  const config = { enabled: false, strategy: "direct", concurrentRequests: false, capacity: 1, retentionDays: 7, ...value };
  if (typeof config.enabled !== "boolean" || typeof config.concurrentRequests !== "boolean" ||
      typeof config.strategy !== "string" || !/^[a-z][a-z0-9_-]*$/.test(config.strategy) ||
      !Number.isSafeInteger(config.capacity) || config.capacity < 1 ||
      !Number.isSafeInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 3650) throw Error("Invalid dispatcher configuration");
  if (config.enabled && !config.concurrentRequests) throw Error("Dispatcher requires explicit concurrentRequests support");
  return config;
}
