import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Undefined restores the captured startup baseline; null explicitly disables. */
export type StrategySelection = string | null | undefined;

/** Trusted in-process pure strategy, not a sandbox or a provider lifecycle.
 * The caller must reserve its owner's idle boundary around change(). Entry modules
 * reload; transitive ESM dependencies retain Node's cache semantics. Capture current
 * once per assessment. Persistence must succeed before the new generation is visible.
 */
export class PureStrategy<T> {
  private readonly baseline: T | undefined;
  private value: T | undefined;
  private selected: StrategySelection;
  private changing = false;
  constructor(private readonly home: string, baseline: unknown | undefined,
    private readonly validate: (module: unknown) => T,
    private readonly prepare: (module: unknown) => T | Promise<T> = validate) {
    this.baseline = baseline === undefined ? undefined : validate(baseline);
    this.value = this.baseline;
  }
  get current(): T | undefined { return this.value; }
  get selection(): StrategySelection { return this.selected; }

  async change(selection: StrategySelection, persist: (selection: StrategySelection) => Promise<void>): Promise<void> {
    if (this.changing) throw Error("Strategy change already in progress");
    if (selection !== undefined && selection !== null && (typeof selection !== "string" || !selection.trim())) {
      throw Error("Invalid strategy selection");
    }
    this.changing = true;
    try {
      let candidate: T | undefined;
      if (selection === undefined) candidate = this.baseline;
      else if (selection === null) candidate = undefined;
      else {
        const url = pathToFileURL(path.resolve(this.home, selection));
        url.searchParams.set("generation", randomUUID());
        candidate = await this.prepare((await import(url.href)).default);
      }
      await persist(selection);
      this.value = candidate;
      this.selected = selection;
    } finally { this.changing = false; }
  }
}
