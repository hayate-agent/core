import { hashtagModel } from "./hashtag-config.js";
import type { PluginHost } from "./plugins.js";
import { runtimeReviewer } from "./runtime/reviewer.js";
import type { SettingsService } from "./settings.js";
import { HASHTAG_ATTEMPT_MS, fastTopicLabeler, tagsOnlyHashtagPlugin, topicModelChain } from "./topic-labels.js";
import type { AgentRuntime } from "./types.js";

/** Shared CLI startup wiring. Read the active overlay at each classification,
 * not the startup snapshot, and use the same service registry loaded by CLI. */
export function createHashtagStartup(runtime: AgentRuntime, settings: SettingsService, plugins: PluginHost) {
  const backend = runtimeReviewer(runtime, "hashtag");
  return {
    topicLabeler: fastTopicLabeler(backend,
      scopeMain => topicModelChain(settings.effective().modelRoles, scopeMain ?? settings.effective().model, settings.effective().hashtag?.model),
      plugins.services, HASHTAG_ATTEMPT_MS, () => settings.effective().hashtag?.provider),
    plugin: tagsOnlyHashtagPlugin(backend, scopeMain => hashtagModel({ ...settings.effective(), model: scopeMain ?? settings.effective().model })),
  };
}
