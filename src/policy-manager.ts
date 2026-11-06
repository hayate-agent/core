import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Harness } from "./harness.js";
import { PolicyRegistry, type Policy } from "./policies.js";
import type { SettingsService } from "./settings.js";
import { validatePolicyOverlay, type PolicyInstance, type PolicyModule } from "./policy-modules.js";

/** Trusted local ESM, not a sandbox. Activation reserves the host's idle boundary. */
export class PolicyManager {
  private readonly active = new Map<string, PolicyInstance>();
  private readonly baseline = new Map<string, Readonly<Policy> | undefined>();
  private readonly pending = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly degraded = new Set<string>();
  private readonly resources = new Set<PolicyInstance>();
  private generation = 0;
  private flight?: Promise<void>;
  private stopping = false;
  private stopped?: Promise<void>;
  constructor(private readonly harness: Pick<Harness, "atIdleBoundary">, private readonly registry: PolicyRegistry,
    private readonly settings: SettingsService, private readonly context: { home: string; cwd: string; agent: string }) {}
  async load(): Promise<void> {
    for (const id of Object.keys(this.settings.desired().policyPlugins ?? {})) await this.request(id);
    await this.tick();
    if (this.pending.size || this.errors.size) throw Error("Initial policy activation failed; inspect policy status/local module");
  }
  /** Check before persisting desired state; required identities cannot be disabled. */
  validate(id: string, spec = this.settings.desired().policyPlugins?.[id]): void {
    validatePolicyOverlay({ [id]: spec ?? {} });
    if (this.stopping) throw Error("Policy manager stopping");
    if (this.degraded.has(id)) throw Error("Policy lifecycle uncertain; restart required");
    if (spec?.disabled && this.registry.isRequired(id)) throw Error("Required policy cannot be disabled");
  }
  async request(id: string): Promise<void> {
    try { this.validate(id); } catch (error) {
      this.errors.set(id, "Invalid desired policy configuration; previous selection retained");
      throw error;
    }
    if (!this.baseline.has(id)) this.baseline.set(id, this.registry.get(id));
    this.pending.set(id, ++this.generation);
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.flight) return this.flight;
    const flight = this.activate();
    this.flight = flight;
    void flight.finally(() => { if (this.flight === flight) this.flight = undefined; }).catch(() => {});
    return flight;
  }
  private install(id: string, policy?: Readonly<Policy>): void {
    if (policy) {
      if (this.registry.has(id)) this.registry.replace(policy); else this.registry.register(policy);
    } else this.registry.remove(id);
  }
  private quarantine(id: string): void {
    this.degraded.add(id);
    const fail = async (): Promise<never> => { throw Error("Policy lifecycle uncertain; restart required"); };
    this.install(id, { id, prepare: fail, beforeTool: fail, finish: fail, assertAllowed: fail });
  }
  private async cleanup(instance: PolicyInstance): Promise<void> {
    if (typeof instance.stop === "function") await instance.stop();
    this.resources.delete(instance);
  }
  private async apply(id: string, generation: number): Promise<void> {
    const spec = this.settings.desired().policyPlugins?.[id];
    this.validate(id, spec);
    const previous = this.active.get(id);
    let candidate: PolicyInstance | undefined;
    let oldStopAttempted = false;
    try {
      let policy = spec?.disabled ? undefined : this.baseline.get(id);
      if (!spec?.disabled && spec?.module) {
        const url = pathToFileURL(path.resolve(this.context.home, spec.module));
        url.searchParams.set("activation", randomUUID());
        const module = (await import(url.href)).default as PolicyModule;
        if (module?.apiVersion !== 1 || typeof module.create !== "function") throw Error("Invalid policy module");
        candidate = await module.create({ ...this.context });
        if (!candidate || typeof candidate !== "object") throw Error("Invalid policy instance");
        // Keep malformed instances with callable cleanup owned until cleanup succeeds.
        this.resources.add(candidate);
        if (candidate.policy?.id !== id || [candidate.start, candidate.stop].some(fn => fn !== undefined && typeof fn !== "function")) throw Error("Invalid policy instance");
        // Validate and bind before starting resources or touching the live registry.
        const validation = new PolicyRegistry(); validation.register(candidate.policy);
        policy = validation.get(id);
        await candidate.start?.();
      }
      if (this.stopping || this.pending.get(id) !== generation) {
        if (candidate) await this.cleanup(candidate);
        return;
      }
      if (previous) { oldStopAttempted = true; await previous.stop?.(); }
      if (this.stopping || this.pending.get(id) !== generation) throw Error("Superseded during cleanup");
      this.install(id, policy);
      if (previous) this.resources.delete(previous);
      if (candidate) this.active.set(id, candidate); else this.active.delete(id);
      this.errors.delete(id);
      this.settings.appliedPlugin("policyPlugins", id, spec);
    } catch {
      let uncertain = false;
      if (candidate && this.resources.has(candidate)) {
        try { await this.cleanup(candidate); } catch { uncertain = true; }
      }
      if (oldStopAttempted && previous) {
        try {
          if (!previous.start) throw Error("No restart contract");
          await previous.start();
        } catch { uncertain = true; }
      }
      if (uncertain) this.quarantine(id);
      // Never expose module errors/paths; those may include credentials.
      this.errors.set(id, uncertain ? "Cleanup/rollback failed; policy blocked, restart required" : "Activation failed; previous selection retained");
    }
  }
  private async activate(): Promise<void> {
    for (const [id, generation] of [...this.pending]) {
      if (this.stopping) break;
      let entered = false;
      try {
        await this.harness.atIdleBoundary(async () => {
          entered = true;
          try { await this.apply(id, generation); }
          catch { this.errors.set(id, this.degraded.has(id) ? "Cleanup/rollback failed; policy blocked, restart required" : "Invalid desired policy configuration; previous selection retained"); }
        });
      } finally {
        // A busy boundary is retried; an attempted activation needs an explicit new request.
        if (entered && this.pending.get(id) === generation) this.pending.delete(id);
      }
    }
  }
  /** Call after Harness drain: hooks must stay live until running turns finish. */
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    this.pending.clear();
    this.stopped = (async () => {
      await this.flight?.catch(() => {});
      const errors: unknown[] = [];
      for (const instance of this.resources) try { await this.cleanup(instance); } catch { errors.push(Error("Policy cleanup failed")); }
      this.active.clear();
      if (errors.length) throw new AggregateError(errors, "Policy cleanup failed");
    })();
    return this.stopped;
  }
  status(): string {
    return JSON.stringify({ active: [...this.active.keys()], pending: [...this.pending.keys()], degraded: [...this.degraded], errors: Object.fromEntries(this.errors) });
  }
}
