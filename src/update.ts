export type UpdateTarget = "skills" | "cron";
export interface UpdateResult { component: string; status: "available" | "activated" | "failed" | "activated-with-warnings" | "unsupported" | "rollout-required"; detail: string }

/** Reconcile already provisioned local overlays. No network fetch or code import. */
export class OverlayUpdater {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly verify: () => Promise<void>, private readonly reloaders: Record<UpdateTarget, () => Promise<void | { warnings: number }>>) {}
  run(action: "status" | "apply", targets: UpdateTarget[]): Promise<UpdateResult[]> {
    const next = this.pending.catch(() => undefined).then(async () => {
      if (!["status", "apply"].includes(action) || !targets.length || targets.some(x => !["skills", "cron"].includes(x))) throw Error("Unsupported update request");
      await this.verify(); // Fail closed before any activation.
      const results: UpdateResult[] = [];
      for (const target of [...new Set(targets)]) {
        if (action === "status") results.push({ component: target, status: "available", detail: "Local reconciliation supported; freshness not checked" });
        else {
          try {
            const result = await this.reloaders[target]();
            results.push({ component: target, status: result?.warnings ? "activated-with-warnings" : "activated",
              detail: result?.warnings ? `Local source reloaded with ${result.warnings} diagnostics; inspect component logs` : "Configured source activated; inspect installation configuration for local/pinned-download mode" });
          }
          catch { results.push({ component: target, status: "failed", detail: "Reload failed; inspect component diagnostics" }); }
        }
      }
      results.push({ component: "core", status: "rollout-required", detail: "GitOps rollout required; no running-version comparison performed" },
        { component: "plugins/mcp/settings", status: "unsupported", detail: "No general transactional hot reload; use component-specific commands or rollout" });
      return results;
    });
    this.pending = next;
    return next;
  }
}
