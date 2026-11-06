// SPDX-License-Identifier: Apache-2.0
import type { Inbound, PromptOptions, RuntimeSession } from "./types.js";

/** Trusted policy implementations. Registration never grants tool permissions. */
export interface Policy {
  id: string;
  prepare?(cwd: string, input: Inbound): Promise<void>;
  beforeTool?(cwd: string, tool: string, input: unknown): Promise<void>;
  finish?(cwd: string, input: Inbound, reply: string, session: RuntimeSession, options: PromptOptions, signal?: AbortSignal): Promise<string>;
  assertAllowed?(cwd: string, action: "local" | "publish" | "merge"): Promise<void>;
}

/** Required identities survive failed registration/cleanup; absence is never approval.
 * Each invocation snapshots its ordered generation; replacement never creates a gap.
 */
export class PolicyRegistry {
  private readonly policies = new Map<string, Readonly<Policy>>();
  private readonly required: Set<string>;
  constructor(required: readonly string[] = []) { this.required = new Set(required); }
  /** Trusted host composition only; plugins cannot weaken required identities. */
  require(ids: readonly string[]): void {
    if (ids.some(id => !/^[a-z][a-z0-9-]*$/.test(id))) throw Error("Invalid required policy");
    for (const id of ids) this.required.add(id);
  }
  register(policy: Policy): () => void {
    if (this.policies.has(policy?.id)) throw Error(`Policy conflict: ${policy.id}`);
    return this.install(policy);
  }
  /** Atomic same-ID replacement keeps the original registration position. */
  replace(policy: Policy): () => void {
    if (!this.policies.has(policy?.id)) throw Error(`Unknown policy: ${policy?.id}`);
    return this.install(policy);
  }
  entries(): ReadonlyArray<readonly [string, Readonly<Policy>]> { return [...this.policies.entries()]; }
  has(id: string): boolean { return this.policies.has(id); }
  isRequired(id: string): boolean { return this.required.has(id); }
  get(id: string): Readonly<Policy> | undefined { return this.policies.get(id); }
  remove(id: string): void {
    if (this.required.has(id)) throw Error(`Required policy cannot be removed: ${id}`);
    this.policies.delete(id);
  }
  private install(policy: Policy): () => void {
    if (!policy || !/^[a-z][a-z0-9-]*$/.test(policy.id) ||
        ![policy.prepare, policy.beforeTool, policy.finish, policy.assertAllowed].some(fn => typeof fn === "function") ||
        [policy.prepare, policy.beforeTool, policy.finish, policy.assertAllowed].some(fn => fn !== undefined && typeof fn !== "function")) throw Error("Invalid policy");
    const bound = Object.freeze({
      id: policy.id,
      ...(policy.prepare ? { prepare: policy.prepare.bind(policy) } : {}),
      ...(policy.beforeTool ? { beforeTool: policy.beforeTool.bind(policy) } : {}),
      ...(policy.finish ? { finish: policy.finish.bind(policy) } : {}),
      ...(policy.assertAllowed ? { assertAllowed: policy.assertAllowed.bind(policy) } : {}),
    });
    this.policies.set(policy.id, bound);
    return () => {
      // An obsolete module's cleanup cannot unsubscribe its replacement.
      if (this.policies.get(policy.id) === bound) this.remove(policy.id);
    };
  }
  assertReady(): void {
    for (const id of this.required) if (!this.policies.has(id)) throw Error(`Required policy unavailable: ${id}`);
  }
  clear(): void { this.policies.clear(); }
  async prepare(cwd: string, input: Inbound): Promise<void> {
    this.assertReady();
    for (const policy of [...this.policies.values()]) await policy.prepare?.(cwd, input);
  }
  async beforeTool(cwd: string, tool: string, input: unknown): Promise<void> {
    this.assertReady();
    for (const policy of [...this.policies.values()]) await policy.beforeTool?.(cwd, tool, input);
  }
  async finish(cwd: string, input: Inbound, reply: string, session: RuntimeSession, options: PromptOptions, signal?: AbortSignal): Promise<string> {
    this.assertReady();
    for (const policy of [...this.policies.values()]) if (policy.finish) reply = await policy.finish(cwd, input, reply, session, options, signal);
    return reply;
  }
  async assertAllowed(cwd: string, action: "local" | "publish" | "merge"): Promise<void> {
    this.assertReady();
    for (const policy of [...this.policies.values()]) await policy.assertAllowed?.(cwd, action);
  }
}
