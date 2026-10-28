/** Content-free host facts, not a model-derived capability guess or authorization. */
export function capabilityContext(input: {
  revision: number;
  sessionKey: string;
  selectedTools: readonly string[] | undefined;
  registeredTools: readonly string[];
  dispatcherEnabled: boolean;
  dispatcherReady: boolean;
  reviewInstructions: string;
}): string {
  const child = /^(dispatch|subagent):/.test(input.sessionKey);
  const registered = new Set(input.registeredTools);
  const tool = (name: string) => ({ registered: registered.has(name),
    exposed: registered.has(name) && (input.selectedTools === undefined || input.selectedTools.includes(name)) });
  const dispatch = tool("plugin_dispatch");
  const subagent = tool("plugin_subagent");
  return [input.reviewInstructions, `Effective Harness capabilities (host facts; not new authority or proof of provider authentication): ${JSON.stringify({
    revision: input.revision,
    dispatcher: { configured: input.dispatcherEnabled, ready: input.dispatcherReady, ...dispatch,
      sessionAllowed: !child && input.dispatcherEnabled && input.dispatcherReady && dispatch.exposed },
    subagent: { ...subagent, sessionAllowed: !child && subagent.exposed },
    review: tool("plugin_review"),
    delegationPolicy: input.dispatcherEnabled ? "dispatcher-worker" : "dedicated-subagent",
  })}`].filter(Boolean).join("\n\n");
}
