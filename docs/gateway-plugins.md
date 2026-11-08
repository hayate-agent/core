# Runtime gateway modules (v1)

For first-time setup rather than module implementation, start with the
[terminal, WebUI, Matrix and dispatcher walkthrough](gateways.md).
Matrix's normal baseline is already bundled and activates from `MATRIX_*`
configuration. The optional WebUI is built/installed separately and selected with
`gatewayPlugins.webui.module` in `settings.local.yaml`. `gateways.progress` is
feedback policy, not an activation switch.

The CLI consumes a bundled gateway-module catalog rather than constructing Matrix
or naming its factory. Matrix factory, transport, sync recovery and native activity
delivery are maintained in [hayate-agent/plugins](https://github.com/hayate-agent/plugins) and materialized from the immutable
`plugins.lock.json` revision into generated `builtin-plugins/` modules. The default
factory implements `src/gateway-provider.ts`; MATRIX_* settings remain compatible.
Existing local GatewayModule overrides and disable/baseline operations are unchanged.
This is source ownership separation: bundled modules still compile into the image;
changing that pin requires a build and rollout, not runtime hot replacement.

A module exports default `{ apiVersion: 1, async create(context) { ... } }`.
Context supplies home, agent and initial approvers. Return `{ channel, home?,
approvers? }`, or undefined when not configured. Channel implements the native
transport-neutral Channel contract, including durable Inbound identities and
SendMeta. create must only prepare resources, never start receivers or external
side effects. start begins receiving; stop must fully quiesce and support restart
for rollback. Preserve channel name, session keys and upstream event IDs when
replacing an existing gateway. New message IDs must remain deduplicable.

Admin commands:

- `/gateway-plugin status`
- `/gateway-plugin use matrix plugins/my-matrix.mjs`
- `/gateway-plugin reload matrix`
- `/gateway-plugin disable matrix`
- `/gateway-plugin baseline matrix`

Paths resolve against Harness home. Only explicitly installed local ESM is loaded;
there is no download/package marketplace. Overrides are persisted separately under
`gatewayPlugins` in settings.local.yaml. Removing an override selects the bundled
baseline; disabling is distinct. Existing baseline files are never overwritten.

Activation is queued until an idle boundary (currently instance-wide, not just
that gateway). During transition input acceptance is refused so upstream retries;
no turns are started. The old receiver stops before the new one starts. Failed
candidate start attempts restart the old adapter. Inbox/outbox stay in the core.
A stop implementation that returns before it actually stops violates the contract.
Status distinguishes pending changes and activation errors. Persisted desired
configuration remains even after activation failure; repair it before restart.
Initial invalid modules fail startup instead of silently ignoring an override.

This v1 runtime is for **trusted in-process JavaScript**, not a sandbox. Factories
can access process credentials/files. An activation query reloads the entry module;
ESM dependencies remain cached. Publish complete versioned module directories for
code changes; overwriting shared imported dependencies is not reliable hot reload.
Old imported modules are not unloaded from Node's module cache. Use process
isolation for untrusted code or unlimited repeated activations; this is follow-up,
not implemented here. A default reply destination adopted from a gateway follows successful replacement;
disabling that gateway selects the first remaining configured home, or clears the
adopted default when none remain. An explicitly assigned operator destination is
not overwritten. Failed activation leaves the previous destination intact.

Admin and approver policies are resolved at startup and do
not broaden on plugin replacement. Console/API are core operator interfaces and
are not replaceable through this command. TUI and existing general plugins retain
their current lifecycle. This does not implement general policy inspection,
immutable skills, MCP lifecycle or universal settings overlays.
