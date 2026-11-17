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
/** Hashtag model chain: hashtag.model, else the explicit Basic model
 * (modelRoles.roles.basic, when roles are enabled), else Main of the current
 * scope (effective settings incl. overlay). Thinking is always off at the call site. */
export function hashtagModel(settings: { hashtag?: HashtagConfig; model?: string; modelRoles?: { enabled: boolean; roles?: { basic?: { model?: string } } } }): string | undefined {
  const basic = settings.modelRoles?.enabled ? settings.modelRoles.roles?.basic?.model : undefined;
  return settings.hashtag?.model ?? basic ?? settings.model;
}
