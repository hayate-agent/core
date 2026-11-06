// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import type { ReviewConfig } from "./config.js";
import type { Changeset } from "./changeset.js";

/** Paths from Git, not model labels. Required patterns take precedence; unknown files fail closed. */
export function requiresReview(change: Changeset, config: ReviewConfig): boolean {
  if (!change.diff) return false;
  if (config.scope.mode === "all") return true;
  return change.files.length === 0 || change.files.some((file) =>
    config.scope.requiredPaths.some((pattern) => path.matchesGlob(file, pattern)) ||
    !config.scope.nonBlockingPaths.some((pattern) => path.matchesGlob(file, pattern)));
}
