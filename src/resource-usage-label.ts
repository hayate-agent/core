import { message } from "./language.js";

export type ResourceUsage = { resource: "skill" | "memory"; action: "loaded" | "recalled" | "created" | "updated"; name?: string; locale?: string };
/** Only bounded skill identifiers enter channel activity; never paths or contents. */
export function resourceUsageLabel(event: ResourceUsage): string {
  const locale = event.locale ?? "en";
  if (event.resource === "memory") return message(locale, "usage.memory.recalled");
  const name = event.name && /^[\p{L}\p{N}_.-]{1,80}$/u.test(event.name) ? event.name : "—";
  const key = event.action === "created" ? "usage.skill.created" : event.action === "updated" ? "usage.skill.updated" : "usage.skill.loaded";
  return message(locale, key, { name });
}
