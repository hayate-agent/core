export interface HashtagConfig {
  model?: string;
  /** default keeps the version-1 topic-labeler override; other names select a service. */
  provider?: string;
}
export function validateHashtagConfig(value: unknown): asserts value is HashtagConfig | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid hashtag configuration");
  for (const [key, entry] of Object.entries(value)) {
    if (key === "model" && typeof entry === "string" && /^[^/\s]+\/[^\s]+$/.test(entry)) continue;
    if (key === "provider" && typeof entry === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(entry)) continue;
    throw Error(`Invalid hashtag.${key}`);
  }
}
/** Metadata has one explicit model override; otherwise use Main, never a role
 * chain. Legacy modelRoles.hashtag remains parseable, but no longer selects it. */
export function hashtagModel(settings: { hashtag?: HashtagConfig; model?: string }): string | undefined {
  return settings.hashtag?.model ?? settings.model;
}
