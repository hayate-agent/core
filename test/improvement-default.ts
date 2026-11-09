import { ImprovementController as Controller, type NightlyCompletionValidator } from "../src/improvement.js";
import nightlyDefault from "../src/builtin-plugins/nightly-default.js";
import type { Harness } from "../src/harness.js";
export { improvementPolicy, improvementWindow } from "../src/improvement.js";
/** Tests explicitly inject the production bundled strategy, not a Core fallback. */
export class ImprovementController extends Controller {
  constructor(home: string, harness: Harness, timezone: string, now = Date.now, validateClosure?: NightlyCompletionValidator) {
    super(home, harness, timezone, now, nightlyDefault, validateClosure);
  }
}
