import type { ReviewService } from "./review.js";

/** Defense in depth for standard shell workflows, NOT an OS/process sandbox. */
export async function guardReviewTool(service: ReviewService, cwd: string, tool: string, input: unknown): Promise<void> {
  if (!service.config.enabled || !service.config.shellGuard || tool !== "bash") return;
  const command = (input as { command?: unknown })?.command;
  if (typeof command !== "string") return;
  // Fail closed on common publication entry points. Arbitrary scripts and remote tools
  // need external branch protection; a shell cannot be safely authorized by regex.
  if (/\b(?:merge|rebase)\b/.test(command) && /\bgit\b/.test(command)) {
    await service.assertAllowed(cwd, "merge");
  }
  if (/\b(?:push|send-email)\b/.test(command) && /\bgit\b/.test(command) ||
      /\b(?:gh|glab)\b[\s\S]*\b(?:pr|mr)\b[\s\S]*\b(?:create|merge)\b/.test(command)) {
    await service.assertAllowed(cwd, /\bmerge\b/.test(command) ? "merge" : "publish");
  }
}
