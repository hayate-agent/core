# Trusted execution contexts and backend services

These transport-neutral contracts let plugins own headless workspace/agent-overlay
features without moving their domain state into Core or a browser gateway.

## Immutable execution context

Trusted `PluginAPI.executionContexts` provides `get(sessionKey)` and asynchronous
`bind(sessionKey, { cwd, directories? })`. Bind before admitting the stream's first
message. Directories are canonical existing absolute directories; a binding is
persisted before resolving and cannot be retargeted. Reorganizing a conversation
must not change this context. Use a new stream to change execution directories.

Contexts are persisted privately in `<home>/execution-contexts.json`. Core loads
bindings before recovering sessions, captures contexts of pre-existing host
conversations before plugin activation, and captures worker ancestry on first PI
open. A worker's reopened history retains its directory after its parent's current
claim changes. No code calls `process.chdir()`.

PI native tools/resources/session history, plugin tool/command context (`cwd`),
persona project files, progress evidence and policy prepare/tool/finish hooks use
the resolved cwd. Dedicated review worktrees keep their explicitly assigned cwd.
Additional directories are declared context, **not** a filesystem sandbox or a
permission grant. Existing approvals and execution restrictions remain authoritative.

Review engines explicitly declare `executionContexts: 1` in their generic policy
module; the bundled adapter selection reads its factory's capability marker.
An older selected review adapter cannot accept a non-default stream binding when
review is enabled. A compatible review adapter is required; inspect its capability
rather than assuming support from a release number. Core's existing bundled adapter
update process remains unchanged. The workspace/WebUI overlay is installed and
updated separately and does not require an overlay revision pin in Core.

## Versioned backend services

During activation a plugin can register a trusted in-process implementation:

```js
api.registerService('example-workspace', 1, service);
const dependency = api.services.get('example-credentials');
if (dependency?.version !== 1) throw Error('Compatible credentials service required');
```

Service names must be lowercase kebab-case, versions positive integers and
implementations objects. Duplicate registrations fail activation. Registration
closes after activation; lookups remain live. Activation failure and host stop
clear the registry. Consumers must explicitly check versions and load dependencies
before consumers. A GatewayFactoryContext exposes the same lookup capability.
These objects are not a remote API, access-control layer, DI framework or sandbox.

Trusted asynchronous work outside a model turn uses
`api.foregroundWork(() => operation())`. This reserves existing host update admission;
the plugin must still fence new calls and drain its accepted operations on stop.
Do not claim `foreground-owned` cleanup for untracked remote operations.

Plugin-channel messages can supply string-valued `turn.model`, `turn.thinking` and
`turn.instructions` overrides. They are validated, cloned and fed through the
normal Harness; they cannot replace tools, approvals or authority. A plugin that
exposes settings must authenticate its operator and preserve the original settings
snapshot for a retry with the same message identity.

## Verification

`test/execution-contexts.test.ts` covers durable immutability, captured worker
ancestry and service lifecycle. `test/execution-context-runtime.test.ts` exercises
actual PI bash/plugin tools concurrently in two directories and one inherited
worker directory. Companion Plugins tests cover headless host integration and
formal review of independent Git changesets with a non-repository startup cwd.
