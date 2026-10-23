# Harness plugins (API version 1)

Plugins are explicitly enabled local ESM modules. They execute trusted JavaScript
with the process user's permissions: this is NOT a sandbox. Review code and pin
its dependencies. No discovery/download/installation from incoming chat messages.

In harness.yaml:

```yaml
plugins:
  - plugins/greeting.mjs
```

Relative paths resolve against Harness home, not current project. Absolute paths
also work. Compile TypeScript plugins to ESM before use. Restart after changes;
hot reload, package marketplace and dependency management are not implemented.

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

## Deliberate limits

Version 1 exposes commands, channels and lifecycle. Runtime-neutral model tools,
UI panels, package installation and secret references still
need dedicated contracts and tests. PI runtime extensions remain independent.
No plugin gets the internal Harness object or starts another agent loop.
