import type { Inbound, PromptOptions, RuntimeSession } from "./types.js";

/** Trusted, startup-selected policy implementations. No implicit tool permissions. */
export interface Policy {
  id: string;
  prepare?(cwd: string, input: Inbound): Promise<void>;
  beforeTool?(cwd: string, tool: string, input: unknown): Promise<void>;
  finish?(cwd: string, input: Inbound, reply: string, session: RuntimeSession, options: PromptOptions, signal?: AbortSignal): Promise<string>;
  assertAllowed?(cwd: string, action: "local" | "publish" | "merge"): Promise<void>;
}

/** Required identities survive failed registration/cleanup; absence is never approval.
 * Replacement is startup-only: construct a new host, never drop a live mandatory gate.
 */
export class PolicyRegistry {
  private readonly policies = new Map<string, Readonly<Policy>>();
  constructor(private readonly required: readonly string[] = []) {}
  register(policy: Policy): void {
    if (!policy || !/^[a-z][a-z0-9-]*$/.test(policy.id) ||
        ![policy.prepare, policy.beforeTool, policy.finish, policy.assertAllowed].some(fn => typeof fn === "function") ||
        [policy.prepare, policy.beforeTool, policy.finish, policy.assertAllowed].some(fn => fn !== undefined && typeof fn !== "function")) throw Error("Invalid policy");
    if (this.policies.has(policy.id)) throw Error(`Policy conflict: ${policy.id}`);
    this.policies.set(policy.id, Object.freeze({
      id: policy.id,
      ...(policy.prepare ? { prepare: policy.prepare.bind(policy) } : {}),
      ...(policy.beforeTool ? { beforeTool: policy.beforeTool.bind(policy) } : {}),
      ...(policy.finish ? { finish: policy.finish.bind(policy) } : {}),
      ...(policy.assertAllowed ? { assertAllowed: policy.assertAllowed.bind(policy) } : {}),
    }));
  }
  assertReady(): void {
    for (const id of this.required) if (!this.policies.has(id)) throw Error(`Required policy unavailable: ${id}`);
  }
  clear(): void { this.policies.clear(); }
  async prepare(cwd: string, input: Inbound): Promise<void> {
    this.assertReady();
    for (const policy of this.policies.values()) await policy.prepare?.(cwd, input);
  }
  async beforeTool(cwd: string, tool: string, input: unknown): Promise<void> {
    this.assertReady();
    for (const policy of this.policies.values()) await policy.beforeTool?.(cwd, tool, input);
  }
  async finish(cwd: string, input: Inbound, reply: string, session: RuntimeSession, options: PromptOptions, signal?: AbortSignal): Promise<string> {
    this.assertReady();
    for (const policy of this.policies.values()) if (policy.finish) reply = await policy.finish(cwd, input, reply, session, options, signal);
    return reply;
  }
  async assertAllowed(cwd: string, action: "local" | "publish" | "merge"): Promise<void> {
    this.assertReady();
    for (const policy of this.policies.values()) await policy.assertAllowed?.(cwd, action);
  }
}
