import { fileURLToPath } from "node:url";

/** Resolved from installed package, not from the operator's current project. */
export const developmentGuide = fileURLToPath(new URL("../docs/development.md", import.meta.url));

export function developmentContext(): string {
  return `# Harness development resources\nThe version-matched VanillaCore Harness development guide is at ${JSON.stringify(developmentGuide)}. Read it with the read tool before modifying or extending the Harness. It describes supported customization, source entry points, tests and current limits. The package directory is not necessarily a writable source checkout. Do not claim planned extension APIs already exist.`;
}
