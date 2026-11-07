# Hayate WebUI (local, opt-in plugin)

A separate native gateway, **not a Core UI and not another agent runtime**.
Requires Hayate's GatewayModule v1 contract and Node >=22.19. The same ESM entry
also optionally implements PluginModule v1 to expose presentation settings as an
agent tool. No changes to Core, bundled-plugin pins or the TUI are required.

## Architecture and design decisions

The existing TUI is a host-owned channel with native transcript, activity,
Markdown, scrolling and model status. Existing runtime gateways already have the
right boundary for a browser: `start`, durable inbound acceptance, `send`, stable
message identities, live `turnEvent`, `typing`, and `stop`.

This implementation uses that boundary:

- Native session keys `webui:<conversation UUID>`; stable inbound IDs scoped by
  conversation. The browser cannot choose sender, source or a foreign session.
- Core retains commands, authority checks, approvals, scheduling, model selection,
  tool execution, inbox/outbox durability, retries and cancellation.
- The plugin persists **presentation**, not a second agent queue. Acceptance is
  confirmed only after the host callback resolves; unconfirmed submissions can
  be retried with their original IDs, even after a browser restart.
- SSE starts with an authoritative snapshot on every connection/reconnection.
  Live updates are throttled and do not repeatedly transmit the retained history.
  Slow clients are disconnected and can reconnect. Streamed text is provisional;
  persisted final delivery replaces it.
- Atomic, serialized JSON replacement stores the transcript under
  `<Hayate home>/webui/conversations.json`, with private file/directory modes for
  newly created files. Stable delivery IDs prevent duplicate final replies.
- Rendering is independent of the execution engine. Browser Markdown uses pinned
  Marked + DOMPurify, a narrow tag/attribute allowlist, no images or executable
  model-generated controls, no embedded frames, and a restrictive CSP.

**No model-dependent constants:** no context-window tables, inferred token counts,
reasoning-level lists, model-name heuristics or invented budget indicators. The
v1 gateway does not expose the TUI's full session-status/catalog API, so model and
context management use the existing `/status`, `/model`, `/reasoning` commands.
Observed model usage is shown while provided through turn events. Unknown context
capacity is not guessed. Transport safeguards (64,000 characters per submitted
message; 300,000 bytes per HTTP body; 32 simultaneous SSE clients; a slow-reader
buffer threshold) are **not model limits** and do not truncate agent context or
final replies. Retained conversation count and history length have no artificial
context-based cap.

## Features

- Persistent multiple conversations, title search, rename and Markdown export.
- Streamed replies, distinct user input, safe Markdown, tables and fenced code.
- Copy response/code, automatic following, scroll-up preservation, jump to latest.
- Actual tool names/counts and failures; honest waiting status. Tool arguments,
  details and hidden reasoning are intentionally not forwarded.
- Enter to send, Shift+Enter for newline, IME-safe input, per-chat drafts,
  `/help` and `/stop` buttons, responsive mobile layout, light/dark appearance.
- Live operator/agent-configurable work area, prompt placeholder, title, panels
  and input actions. Text panels are collapsible and never interpreted as HTML.

## Build and enable

From this directory:

```sh
npm ci
npm run build
npm test
```

`public/app.bundle.js` is generated; rebuild after editing browser source.
For deployment, copy `index.mjs`, `ui.mjs` and the built `public/` directory to a
trusted versioned directory. The gateway itself only imports Node built-ins and
local modules; browser dependencies are bundled. Do not expose the source tree
through an unrelated static-file server.

In `<Hayate home>/settings.local.yaml`, merge with any existing gateway overrides:

```yaml
gatewayPlugins:
  webui:
    module: /absolute/path/to/plugins/webui/index.mjs
```

Restart Hayate, or use its existing trusted operator channel:

```text
/gateway-plugin use webui /absolute/path/to/plugins/webui/index.mjs
```

Open **http://127.0.0.1:3210** (use this exact host, not `localhost`). Optional
startup environment: `HAYATE_WEBUI_PORT=3211`. The factory prepares no receiver;
listening begins in `start`. A busy port fails activation rather than selecting
an unknown port silently. Stop/restart supports the host's gateway rollback.

The fixed sender is **`webui:local`**. It is **not automatically an administrator**.
For operator-only commands, explicitly add it to your `hayate-agent.yaml` admins,
retaining any existing identities:

```yaml
admins:
  - webui:local
```

This grants the local WebUI the same command authority as that configured sender.
Do not grant this if other users of the local machine must not be operators.
Approvals still follow the host's configured approver policy; resolving prompts
uses the existing `/approve <id>` / `/deny <id>` commands.

## Let the agent customize its UI

Optionally also list the entry under the host's startup plugins in
`hayate-agent.yaml` (merge, do not replace your existing list):

```yaml
plugins:
  - /absolute/path/to/plugins/webui/index.mjs
```

This registers **`plugin_webui_settings`**. If the installation uses an explicit
tool allowlist, add that tool there too. Omit `patch` to read current settings;
provide a patch to change presentation according to operator instructions:

```json
{
  "patch": {
    "workArea": "always",
    "workAreaRows": 4,
    "theme": "dark",
    "title": "My workspace",
    "placeholder": "What should we work on?",
    "panels": [{ "title": "Current plan", "text": "1. Inspect\n2. Implement\n3. Verify" }],
    "actions": [{ "label": "Session status", "input": "/status" }]
  }
}
```

Settings live in `<Hayate home>/webui/ui.json`. Browsers apply valid changes
within approximately two seconds. Invalid updates are rejected; invalid manual
file edits retain the last valid presentation with a warning. Work-area values
are `auto`, `always`, `hidden`; rows bound presentation, not model budgets.
Arrays in patches replace their previous values; use `[]` to clear them.
Settings are workspace-wide, not individual-user preferences. Browser-selected
light/dark mode takes precedence locally; removing `hayate.webui.theme` from
localStorage restores the workspace/system setting.

The tool cannot change model limits, grant command authority, configure a network
listener or install executable modules. Its availability follows the host's
existing tool configuration/policies; only enable it where the agent may change
presentation. It does not add a new operator-approval protocol.

## Extend with trusted modules

In `ui.json`, operators may explicitly configure installed local ESM modules:

```json
{ "modules": ["plugins/workspace-panel.mjs"] }
```

Paths resolve relative to Hayate home; absolute local paths work too. Installation
and module-list changes require a gateway restart. The agent's settings tool is
not allowed to modify `modules`. Example module:

```js
export default {
  apiVersion: 1,
  updateAdmission: 'foreground-owned',
  activate(api) {
    api.registerPanel({
      title: 'Workspace',
      render({ agent, conversationId, active }) {
        return `${agent}\nConversation: ${conversationId ?? 'none'}\nActive: ${active}`;
      },
    });
    api.registerAction({ label: 'Inspect session', input: '/status' });
    api.onStop(async () => {
      // Release any resources owned by this module.
    });
  },
};
```

`activate` may be async; registration closes when it returns. `render` must be
synchronous, quick and return plain text, not HTML or a Promise. Exceptions become
`Panel unavailable`, not leaked exception details. Cleanup runs in reverse order
on stop, including partially failed activation. As with other trusted Hayate
modules, arbitrary JS has process privileges: this API is **not a sandbox**.
Each module must explicitly declare `updateAdmission: 'foreground-owned'`.
This is a trusted ownership assertion, not a switch to bypass safety checks:
no independent agent work, background producers or external ingress may be started.
`render` stays synchronous; remaining presentation resources must be drained by
`onStop`. Undeclared modules are rejected **before** activation rather than
silently weakening update admission. For real tools, commands, policies and integrations, continue to use
the host's existing PluginModule API and its explicit operator configuration.
This WebUI module interface is for presentation, not an alternative Core registry.
Existing TUI panels are not silently mirrored; their registry is not part of the
native gateway contract.

Actions only populate visible editor input. Sending remains a deliberate browser
operation and goes through normal host routing and authority checks. Neither
assistant Markdown nor panel text can register modules or execute JavaScript.

## Updates and ordered shutdown

Both the gateway and optional settings plugin implement Core's existing
`updateAdmission: 'foreground-owned'` contract; no Core checks are disabled.
Agent work is routed exclusively through host ingress/tools. An idle browser/SSE
connection is a presentation resource and does not permanently block updates.
Active host work still reports `busy`; an acquired lease refuses new ingress
before acknowledgement. The unconfirmed browser message can be retried with the
same ID after lease release or restart, without duplicating work.

Gateway shutdown fences new input synchronously, closes the listener and all
browser sockets (including incomplete HTTP requests), waits for entered host
acceptance and presentation writes, waits for an in-flight settings refresh, then
runs module cleanup. Concurrent stop calls share one promise. Stop during startup
waits for activation to settle before cleanup. A successful stop supports restart
for gateway rollback; cleanup failure rejects stop and prevents unsafe in-process
restart. The settings tool also fences new calls and drains accepted writes.
Trusted module cleanup must finish promptly; this is not forced process isolation.

**Upgrade from the first local prototype:** its already-running PluginHost retains
the old unsupported-owner classification. Editing files does not change that
classification. A first transition requires an explicitly authorized ordinary
maintenance restart through the runtime owner/supervisor with normal drain; do not
pretend an unavailable admission endpoint granted a lease. After the supported
version starts, use the normal authenticated update-admission acquire/release and
shutdown protocol again. See Core's [update-admission contract](https://github.com/hayate-agent/core/blob/main/docs/update-admission.md).

## Local security and future network exposure

The listener is fixed to **127.0.0.1**. No bind-address option, proxy-header trust,
CORS wildcard, provider key in browser storage or remote-login stub exists.
Exact Host checks mitigate DNS rebinding; same-origin Origin + custom header are
required for mutations, with additional Fetch Metadata validation. This is local
browser isolation, **not user authentication**. Other local processes/users with
loopback access are in the same trust boundary. All local browser tabs share the
same conversations and sender identity.

Do **not** forward this listener to a LAN, publish it behind a reverse proxy, or
assume a password on an unrelated landing page secures its API/SSE routes.

A later authenticated network mode should add at the plugin's HTTP boundary:

1. Explicit opt-in bind address and canonical origin; TLS termination with an
   explicit trusted-proxy policy rather than accepting forwarded headers.
2. Real identity/session lifecycle (e.g. OIDC, HttpOnly/Secure/SameSite cookies,
   CSRF protection, logout/revocation and session expiry during SSE).
3. Principal-bound conversation ownership and checks on **every** read, write,
   event subscription, export, command and extension projection.
4. Host-owned mapping from authenticated principal to sender/approver/admin
   identity. Never let the request body select an operator or session identity.
5. Per-principal quotas/rate limits, audit logging, credential hygiene and tests
   for cross-user conversation access, replay and authorization changes.

No network authentication or multi-user isolation is implemented in this phase.

## DeepSeek research and deliberate differences

Consulted official sources:

- https://api-docs.deepseek.com/guides/thinking_mode/
- https://api-docs.deepseek.com/guides/tool_calls/
- https://api-docs.deepseek.com/ (streaming-compatible chat integration)

The public chat frontend (`https://chat.deepseek.com`) returned HTTP 403 to the
research fetch, so this is **not** a verified feature-by-feature frontend audit.
The design takes the conversational focus and separation of output, work phases
and tools as inspiration, without reproducing branding or claiming identical UX.
Hayate deliberately exposes no chain-of-thought content, and the browser does not
implement DeepSeek API request logic. Provider reasoning/tool protocols remain
inside the runtime; no pretend “DeepThink” or search toggle is shown when the
host has not supplied the corresponding capability. Attachments, search sources,
regeneration/branching, syntax-token highlighting and rich artifact execution
are not implemented or advertised as working buttons.

## Verification and current boundaries

```sh
npm test                         # Gateway, durability, security, settings/modules
npx playwright install chromium
npm run test:browser              # Real Chromium, streaming, XSS, settings, mobile
npm audit
```

The browser suite uses a simulated host callback, not provider credentials or a
live model request. There is also an optional integration test against a sibling
Core checkout's actual `GatewayManager`, `PluginHost` and `Harness`, using its
fake runtime. From the parent directory containing `core/` and `plugins/`:

```sh
node --import ./core/node_modules/tsx/dist/loader.mjs plugins/webui/test/host.mjs ./core
```

This verifies real plugin loading, channel routing, reply delivery, duplicate
ingress, idle/busy update admission, lease fencing, same-ID retry and shutdown with
an open SSE connection. It does not claim a live-provider test against a deployed agent.

The first storage implementation is a single-process JSON presentation store,
intended for local workloads. Full snapshots are sent on conversation writes and
reconnect; very large retained transcripts will eventually need paginated/indexed
storage. There is no remote multi-user isolation, transcript deletion UI, upload
pipeline or cross-gateway TUI history import. UI configuration changes do not
change execution state. History stays on disk and can contain sensitive data;
normal local backup and filesystem access policies apply.
