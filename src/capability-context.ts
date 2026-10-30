/** Default working instructions and host facts, not new authorization. */
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
  return ["ALWAYS vertical slices. ALWAYS KISS. Build the smallest simple end-to-end slice from the concrete request to a verified result, including persistence, restart, continuation and activation when relevant, before horizontal expansion. No speculative abstractions, additional state machines or approval loops; add complexity only when justified by the request and evidence. Tests, merge and image builds are intermediate evidence, not live completion. Preserve safety, authorization and required review; never perform an unauthorized activation. This is an instruction, not mechanical correctness enforcement.", input.reviewInstructions, `Effective Harness capabilities (host facts; not new authority or proof of provider authentication): ${JSON.stringify({
    revision: input.revision,
    dispatcher: { configured: input.dispatcherEnabled, ready: input.dispatcherReady, ...dispatch,
      sessionAllowed: !child && input.dispatcherEnabled && input.dispatcherReady && dispatch.exposed },
    subagent: { ...subagent, sessionAllowed: !child && subagent.exposed },
    review: tool("plugin_review"),
    delegationPolicy: input.dispatcherEnabled ? "dispatcher-worker" : "dedicated-subagent",
  })}`].filter(Boolean).join("\n\n");
}
