# Start using Hayate: terminal, WebUI and Matrix

All three interfaces use the **same Harness**, command routing, model runtime and
persistent delivery. The WebUI and Matrix transports are plugins, not separate
agents. Enable one or both in a single background instance; the terminal remains
available as a separate interactive entry point.

## 1. Create a profile and connect a provider

After [installing Core](installation.md):

```sh
hayate-agent init --home "$HOME/.hayate-agent" --cwd /absolute/path/to/workspace
HAYATE_AGENT_HOME="$HOME/.hayate-agent" hayate-agent
```

`init` creates missing files only and never replaces existing settings or identity.
In the terminal, use `/login` and `/model` to connect/select a real provider/model,
and `/help` for available commands. Existing Pi credentials/catalogs are reused;
for a service, preserve the appropriate `PI_CODING_AGENT_DIR` and environment.
No provider key, model ID, reasoning capability or context size is bundled into
the starter. `doctor --home ...` checks local configuration, not live credentials.

[The commented starter configuration](examples/hayate-agent.yaml) documents the
baseline in `hayate-agent.yaml`: explicit ordinary tools, queued input, a 60-second
shutdown drain, gateway feedback off and background dispatch disabled. These are operating/presentation defaults, not
model context limits. You can use the terminal without running `init`.

### Which file owns what?

| Location | Purpose |
| --- | --- |
| `<home>/hayate-agent.yaml` | Identity, workspace, tools, startup plugins, admins/approvers, dispatcher policy |
| `<home>/settings.local.yaml` | Explicit writable overrides; `gatewayPlugins` selects/disables native gateways |
| Runtime environment / secret manager | Matrix credentials and optional API authentication |
| Pi provider configuration | Model catalog, supported capabilities and provider credentials |
| `<home>/webui/ui.json` | WebUI presentation and explicitly installed UI modules |

`gateways.progress` **does not activate a transport**. `plugins` registers general
startup plugins; `gatewayPlugins` selects native gateway factories. They are not
interchangeable. `gatewayPlugins` belongs in `settings.local.yaml`, not in the
installation YAML. Relative module paths resolve against **Hayate home**, not cwd.
See [settings precedence](configuration.md) and [gateway lifecycle](gateway-plugins.md).
Merge examples into existing mappings/lists instead of replacing other settings.

Use one running owner per home. If you run a terminal profile and a daemon
simultaneously, use separate homes and do not configure both to listen on the
same WebUI port or use the same Matrix device/crypto store.

## 2. Browser: separate dashboard and API gateway

The [WebUI project](https://github.com/hayate-agent/webui) owns the browser
frontend and its deployment. Plugins supplies the API-only `dashboard-api`
gateway. Core no longer packages the removed `Plugins/webui` frontend.

Install the reviewed backend plugins and separate dashboard according to their
current documentation. Preserve trusted backend URLs, authentication/TLS,
conversation storage and operator policies. A channel named `webui` can still
represent the API gateway; it does not prove a frontend is bundled or active.

Do not configure `gatewayPlugins.webui.module` to the retired
`dist/optional-plugins/webui/index.mjs` or reinstall an obsolete Plugins release
to obtain it. Existing configurations using that module require explicit
migration; see [retired browser assets](plugin-assets.md). Core does not rewrite
operator configuration or replace executable modules silently.

A self-update notice may report the independently installed dashboard package.
That is not a claim about the running version of a separate dashboard service.

## 3. Matrix: activate the bundled plugin

Matrix is plugin-owned but **already bundled with Core's pinned plugin catalog**.
Do not add the plugin repository's TypeScript source to `plugins`, and no custom
`gatewayPlugins.matrix.module` path is required for the normal baseline.

The factory remains inactive without credentials. In the service environment,
configure a dedicated bot account and private credentials. This shell example
prompts for the token rather than putting a real secret into a command/history:

```sh
export MATRIX_HOMESERVER='https://matrix.example.org'
export MATRIX_USER_ID='@hayate:example.org'
read -r -s -p 'Bot access token: ' MATRIX_ACCESS_TOKEN; printf '\n'
export MATRIX_ACCESS_TOKEN
# Set the actual stable device ID matching this token (not an invented value).
export MATRIX_DEVICE_ID='YOUR_EXISTING_DEVICE_ID'
export MATRIX_ALLOWED_USERS='@operator:example.org'
export MATRIX_REQUIRE_MENTION=true
export MATRIX_E2EE=true
hayate-agent run --home "$HOME/.hayate-agent"
```

For a supervisor, inject the same environment through a private secret file or
secret manager; a foreground shell's exports do not update a running service.
Alternatively use `MATRIX_USER_ID` + `MATRIX_PASSWORD` login; retain device/session
state and see [Matrix E2EE](matrix-e2ee.md). Never commit credentials or replace a
working crypto store to troubleshoot access.

Before shared-room use, understand these **different** controls:

- `MATRIX_ALLOWED_USERS`: comma-separated allowed sender MXIDs. Keep an explicit
  list; `MATRIX_ALLOW_ALL_USERS` defaults to false.
- `MATRIX_ALLOWED_ROOMS`: restricts ordinary non-DM rooms when nonempty;
  it is **not** the strict conversation boundary because DMs are treated separately.
  It does not replace sender/admin policy.
- `MATRIX_ADMISSION_ROOMS`: optional strict room-ID boundary for inbound traffic,
  invites and outbound delivery, including DMs. If set to an empty value it denies
  all rooms. Use actual `!room:server` IDs, not aliases. Omit for a sender-restricted
  DM-first setup, then explicitly restrict rooms for deployments that require it.
- `MATRIX_REQUIRE_MENTION`: true by default for ordinary rooms; DMs and configured
  free-response/participating thread rules differ.
- `admins` / `approvers` in `hayate-agent.yaml`: privileged command / approval
  resolution identities, independent of whether someone may chat.
- `MATRIX_APPROVAL_APPROVERS`: optional Matrix approver fallback, not a universal
  permission or tool-approval enable switch.

For a Matrix operator, merge real MXIDs into installation config:

```yaml
admins: ["@operator:example.org"]
approvers: ["@operator:example.org"]
```

Restart after startup environment/authority changes, invite the bot from an
allowed user, then send a DM or mention it in an admitted room. Verify `/help` and
a harmless read-only request. For an encrypted room, verify both directions and
restart with the **same** persistent device and crypto state. Do not disable E2EE
as a shortcut. Matrix feedback remains off by default; opt in with
`gateways.progress: reduced` or `MATRIX_PROGRESS=reduced` after considering
metadata disclosure. [Progress](gateway-progress.md) and [E2EE limitations](matrix-e2ee.md).

If Matrix was explicitly disabled in the overlay, `/gateway-plugin baseline matrix`
removes that override and reselects the bundled factory (credentials still needed).
WebUI has no bundled baseline; install and select its module explicitly.

## 4. Optional background delegation: enable the dispatcher

Normal chat works without a dispatcher. For a first deployment, use built-in
`direct`, **only after verifying the backend can handle concurrent
Main/worker/review requests**. The default is four active workers; explicitly lower
it for a constrained backend. Merge into `hayate-agent.yaml`:

```yaml
dispatcher:
  enabled: true
  strategy: direct
  concurrentRequests: true
  capacity: 4
  retentionDays: 7
```

`concurrentRequests: true` is your declaration of backend support, not an automatic
backend probe. Capacity counts active strategy executions, not total model API
requests or tokens. It is not a model context limit. Restart, run `/dispatch status`
from an authorized conversation, then ask the agent to delegate a small read-only
task. `plugin_dispatch` uses the durable task/result path; ordinary Main messages
remain ordinary chat. The host adds the dispatch tool to a nonempty allowlist
when enabled; `tools: []` still means no model tools. Inspect results before
trying tasks with external side effects.

For planned, sequential work instead, configure **actual registered models** for
the required roles, not placeholder IDs copied blindly:

```yaml
dispatcher:
  enabled: true
  strategy: sequential
  concurrentRequests: true
  capacity: 4
modelRoles:
  enabled: true
  roles:
    dispatcher: { model: your-provider/planner }
    simple: { model: your-provider/small-worker }
    medium: { model: your-provider/implementation-worker }
    high: { model: your-provider/complex-worker }
    reviewer: { model: your-provider/reviewer }
    validator: { model: your-provider/validator }
```

One capable model may fill multiple roles. These names describe roles, not a
required provider or product tier. Optional `thinking` values must be supported
by the selected runtime/model; no fixed levels or context lengths are prescribed.
Sequential planning needs the runtime's supported authenticated planner transport;
missing/unavailable explicit roles block rather than silently changing models.
See [dispatcher configuration/recovery](dispatcher.md) and [model roles](model-roles.md)
for exact selection rules, validation, pause/cancel and restart behavior.

## 5. Verification, shutdown and upgrades

- Check `/help`, `/status`, `/context` and `/usage` in the conversation you use.
  Context/token/capability values come from the runtime, not this example.
- A transport being configured is not proof of live provider authentication.
  Verify a real harmless request and its reply in each selected interface.
- A single home persists inbox/outbox, sessions, execution records and Matrix
  crypto state. Back it up privately; do not run two writers against it.
- Use supervisor-managed graceful shutdown and
  [update admission](update-admission.md) before automated maintenance. Supported
  WebUI versions declare and implement resource ownership; an idle SSE connection
  is not a permanent blocker. Actual active work still blocks admission. Older
  plugin versions without this contract require an explicitly authorized initial
  maintenance transition, not disabling the safety check.
- Tool approval prompts are separate from admin/approver lists: `/approvals manual`
  (privileged) enables the existing mechanism; `/approve <id>` / `/deny <id>` resolve
  requests. Plugins and a bash tool still execute with process-user privileges.

For service/API/container details, continue with [installation](installation.md),
[configuration](configuration.md) and [operations](operations.md).
