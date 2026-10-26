# Harness plugins (API version 1)

## Local settings compatibility

Unknown top-level fields in `settings.local.yaml` are preserved on disk but
excluded from effective settings. Startup logs a warning and continues, allowing
operator channels to connect; unknown fields are not treated as active features.
For example, `skills` belongs to installation configuration until explicitly
supported as a local overlay. Invalid known settings (including dispatcher
concurrency policy, routing and model types) still fail validation. The loader
does not print unknown values, which may contain sensitive data. YAML comments
are not preserved when subsequent settings updates serialize the document.

## Source ownership and build

Bundled plugin adapters are maintained in `harness/plugins`, not copied into this
repository. `plugins.lock.json` pins an immutable revision and SHA-256 per source
file. Build, typecheck and test materialize verified sources into ignored
`src/builtin-plugins/`; generated files are never edited or committed. Core owns
engines, policy enforcement, generic plugin/runtime contracts and lifecycle.
Registration, command parsing and tool schemas belong to the plugin repository.
The PI tool bridge remains core runtime integration, not a bundled adapter.

`npm run plugins:materialize` downloads the pinned public sources; for development
`node scripts/materialize-plugins.mjs /path/to/plugins-checkout` verifies the same
hashes against a local checkout. Do not update the pin until its plugin commit is
published. Normal builds require network access to the pinned repository and
fail closed on a mismatch/download failure. Docker uses the same lock and script.
Sources are compiled into the package; this build-time pin does not fetch code at
runtime or replace the separate runtime overlay/loading contracts.


For a no-host-import, tool-only WebAssembly alternative, see [restricted Wasm
tools](wasm-tools.md). It does not confer reduced privileges on ESM plugins.

The Harness also ships a default-enabled [changeset review plugin](review.md).
It is activated from product code, before local plugins, and does not need a module
path in configuration. Its lifecycle and durable policy live in the core.

Other plugins are explicitly enabled local ESM modules. They execute trusted JavaScript
with the process user's permissions: this is NOT a sandbox. Review code and pin
its dependencies. No discovery/download/installation from incoming chat messages.

In harness.yaml:

```yaml
plugins:
  - plugins/greeting.mjs
```

Relative paths resolve against Harness home, not current project. Absolute paths
also work. Compile TypeScript plugins to ESM before use. Restart after changes;
general hot reload, package marketplace and dependency management are not implemented.

## Explicit tool-only reload

Trusted ESM modules that register **only tools** can instead be listed under
`reloadableToolPlugins` (the same local-path syntax as `plugins`). The admin-only
`/tool-plugin status|reload` command loads and validates a replacement generation.
Tool names, descriptions and schemas must remain unchanged; restart for registration
changes. Existing SDK sessions retain stable delegates, so no session/history reset
is needed. Calls already running retain their old generation; its onStop cleanup
runs after its last call finishes. New calls use the replacement. Invalid candidates
leave the previous delegates active and their registered cleanups are attempted.

By default reload is explicit. Set `autoReloadToolPlugins: true` to compare entry
file contents before each working turn and reload changed entries. Concurrent
turn-boundary checks are coalesced. A failed candidate leaves existing tools active
but fails the new turn before model execution; fix the file before retrying. This
is not a background file watcher. Changes in imported dependencies are not detected.
Only entry modules receive
fresh ESM URLs; imported dependencies remain cached. Publish versioned dependency
paths. Node does not unload old ESM modules: after 50 load attempts, restart is
required. Trusted activation/cleanup can hang or produce external side effects;
there is no timeout/isolation or rollback of those effects. Do not register channels,
commands, panels or providers in these modules. They still have full process
privileges. Use the restricted Wasm surface or external isolation when required.

Example plugins/greeting.mjs:

```js
export default {
  apiVersion: 1,
  activate(api) {
    api.registerCommand({
      name: "greeting",
      help: "Greet through the Harness",
      // Defaults to true. Set false only for safe public commands.
      admin: true,
      async run(args, { sessionKey, sender }) {
        return `${api.agent}: Hello ${args || "there"}!`;
      },
    });
    api.onStop(async () => {
      // Close any resources opened during activation.
    });
  },
};
```

## Contract

`activate(api)` may be async. `api.version` is 1; `agent`, `home`, `cwd` are
read-only context strings. Register commands and cleanup only during activation.
The exported TypeScript interfaces live in src/plugins.ts (dist/plugins.js).

Command names are lowercase `[a-z][a-z0-9_-]*`, with help text and async run.
Builtin names/aliases, initially discovered skill names and other plugin commands
cannot be replaced. Plugin commands appear in /help, use existing administrator
checks and reply delivery, and never enter a model turn. Explicit `admin: false`
permits ordinary users. API run requests remain model input, not slash commands.
Do not return secrets; command failures expose only a generic error to channels.
Plugins themselves remain responsible for safe network/resource operations.

Cleanup runs in reverse registration order at shutdown, after Harness drain, and
on partial activation failure. One failing cleanup does not skip the others.
Cleanup must terminate promptly; there is no timeout/sandbox guarantee. Invalid
plugins fail startup rather than silently disappear. External side effects are
not transactional. Use /help to inspect registered commands.

## Composable policy hooks

Trusted startup plugins may call `api.registerPolicy({id, prepare?, beforeTool?,
finish?, assertAllowed?})`. IDs are unique lowercase names. Hooks execute in
registration order; `finish` passes each returned reply to the next hook. Exceptions
propagate and stop later hooks. Class-instance methods retain their receiver.
With no registered policy, calls pass through; there is no implicit generic veto.
These hooks do not grant tool permissions or override cancellation/approvals.

The CLI routes turn preparation, tool checks and reply completion through this
registry. The configured default review adapter is registered first and retains its
existing ledger, budget, severity and assessment semantics. `review.enabled: false`
omits it; it does not disable other plugin policies. The host may require named
policies explicitly; missing required registration fails startup, including after
partial activation cleanup. Plugin activation failure and stop clear registered
hooks. `assertAllowed` is available to trusted host code; arbitrary shell commands
are not automatically intercepted beyond the existing opt-in review shell guard.

This is startup composition, not full policy extraction: the review engine and
selection still live in Core. Duplicate IDs cannot replace a policy. Runtime
replacement, individual removal/unsubscription and persistent policy overlays are
not implemented; restart with the selected modules. Tool-only reload modules must
not register policies. No baseline gate is silently removed by this contract.

## Channels

During activation, call `api.registerChannel(transport)` with a unique lowercase
name, async `start(deliver)`, `send(to, text, meta?)`, and `stop(budgetMs?)` methods.
Optional `typing(to, on)` and `turnEvent(to, event)` methods receive best-effort
progress. Names console, api and matrix are reserved even when disabled.

```js
api.registerChannel({
  name: "my-chat",
  async start(deliver) {
    // Subscribe using your transport; await deliver before acknowledging upstream:
    // await deliver({session: roomId, target: roomId, text, sender, id: eventId});
  },
  async send(to, text, meta) {
    // Send to to.target; use meta's stable delivery ID for upstream deduplication.
  },
  async stop(budgetMs) {
    // Unsubscribe and close transport connections within the supplied budget.
  },
});
```

`deliver` accepts `{session, target, text, sender?, id?, thread?}`. Session/target
must be nonempty strings. The host fixes source and reply-channel fields and
namespaces session keys and message IDs; a transport cannot claim console trust
through message metadata. IDs must be unique per channel, including across rooms.
The namespace is stable across restarts, enabling normal durable inbox/outbox and
dedup behavior. Do not rename a channel without considering its persisted work.
Sender identity must come from authenticated upstream metadata, not message text.
When any plugin channel is configured, empty admin lists fail closed for remote
commands. Configure admins explicitly; local console access remains trusted.

The Harness owns start/stop and response routing. Do not run another model loop.
Start must establish the connection and return, not wait forever for messages.
If any channel start fails, startup attempts Harness stop before plugin cleanup.
Stop may be called even when start did not complete: make it safe and idempotent.
Register activation-time resource cleanup with onStop. There is no transport
sandbox or protection against malicious plugin code ignoring the API contract.

## Model tools

Register tools during activation with a runtime-neutral JSON Schema and async text
result. Names must start with `plugin_`; duplicate plugin names fail startup.

```js
api.registerTool({
  name: "plugin_echo",
  description: "Echo the supplied text",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute(input, { sessionKey, signal }) {
    // Honor signal for cancellable work. Never return credentials.
    return String(input.text);
  },
});
```

The PI adapter registers these in its normal tool pipeline: parameter validation,
tool-call approval hooks and progress events still apply. `tools: []` disables
active model tools; an explicit list must include the desired plugin tool names.
With omitted tools, registered plugin tools join runtime defaults. Execution gets
the Harness session key and cancellation signal, not SDK internals. A tool must
return a string. Errors use the runtime's normal tool error handling; avoid secret
values in exceptions. JSON Schema must be valid for the runtime; malformed schemas
can fail session creation. Registration is not authorization to bypass approval.

## TUI panels

```js
api.registerPanel({
  name: "build-status",
  render({ agent }) {
    return [`${agent}: build ready`];
  },
});
```

Panels are synchronous plain-text status renderers, refreshed by the local TUI.
The shared panel area above the editor has a four-row limit; earlier registrations
have priority. Lines are truncated, control characters are removed, and renderer
errors become a generic unavailable message. Panels never own focus, input,
terminal escape output or the agent loop. Keep rendering fast and side-effect-free;
perform asynchronous refresh in your lifecycle-managed code. Without a TUI panels
are registered but not rendered. This is not an arbitrary interactive widget API.

## Interactive local UI

Local plugin commands receive `context.ui`; remote and headless commands receive
undefined. Check availability rather than trying to open another terminal.

```js
api.registerCommand({
  name: "configure-extension", help: "Configure locally",
  async run(args, { ui }) {
    if (!ui) return "Run this command in the attached Harness TUI.";
    const name = await ui.prompt("Name");
    const mode = await ui.select("Mode", [{ id: "fast", label: "Fast" }]);
    if (await ui.confirm(`Save ${name}?`)) return `Selected ${mode}`;
  },
});
```

`prompt(message, secret?)` masks secret input; `select(message, choices)` returns
a choice ID; `confirm(message)` defaults to No; `notify(message)` writes a local
notice. Dialog rejection means cancellation (Escape/Ctrl-C or TUI shutdown).
Only one dialog can be open at once. Await each before opening the next.
Do not include secret input in returned messages or logs.

For custom interactive forms, `await ui.custom(message, widget)` mounts a widget
in the dialog area and gives it keyboard focus. Widget contract:

```js
const value = await ui.custom("Choose", {
  render(width) { return ["Press y to accept, Escape to cancel"]; },
  handleInput(data) {
    if (data === "y") return { value: "accepted" };
    // Return {cancel:true} to cancel, otherwise stay open.
  },
  invalidate() { /* optional synchronous render-cache invalidation */ },
});
```

Custom widgets render up to twelve bounded plain-text rows. Control characters
are removed; raw terminal escape output is not supported. The host owns focus,
Escape/Ctrl-C handling and restoration of the editor. Input/render errors cancel
the dialog. Render/input handlers must be synchronous and fast. No SDK Component
or internal terminal object is exposed. For background status use panels instead.

## Session storage providers

`api.registerSessionProvider(name, async ({home, options}) => provider)` registers
an authoritative storage implementation selectable with sessions.provider.
Native PI storage is the default; the filesystem snapshot provider remains opt-in and for existing bindings. See sessions.md and the
SessionProvider interface in src/sessions.ts for revision/durability semantics,
legacy import and current large-history limits. This is separate from model tools.

## Compaction strategy

Register `api.registerCompaction('policy', {async compact({instructions, compactNative}) {
await compactNative(instructions); }})` and select `compaction.strategy: policy`.
The built-in native strategy delegates directly to PI; native is reserved.
Strategies wrap manual compaction without receiving or rewriting the session tree.
PI automatic compaction remains configured by PI settings and hooks.

## Dispatcher strategies

`api.registerDispatcher(strategy)` registers a trusted execution strategy with
`name`, positive integer `version`, boolean `replaySafe` and async
`execute(task, context)`. The built-in name `direct` is reserved. Configuration,
claim fencing, effect intents, cancellation and a complete example are described
in [durable dispatcher](dispatcher.md). Registration does not enable dispatcher
mode or grant credentials, subagent access or automatic replay permission.

## Deliberate limits

Version 1 exposes commands, channels, model tools, text panels, interactive local
dialogs/custom widgets and lifecycle. Package installation and secret references
still need dedicated contracts and tests. PI runtime extensions remain independent.
No plugin gets the internal Harness object or starts another agent loop.
