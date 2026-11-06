// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";

/** Resolved from installed package, not from the operator's current project. */
export const developmentGuide = fileURLToPath(new URL("../docs/development.md", import.meta.url));

export function developmentContext(): string {
  return `# Hayate Agent development resources\nThe version-matched Hayate Agent development guide is at ${JSON.stringify(developmentGuide)}. Read it with the read tool before modifying or extending Hayate Agent. It describes supported customization, source entry points, tests and current limits. The package directory is not necessarily a writable source checkout. Do not claim planned extension APIs already exist.`;
}
