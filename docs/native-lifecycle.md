# Native lifecycle: bounded restart and source updates

## Restart is not business completion

`/restart` (`/reload`) and the host-owned `plugin_software_update` tool use the
same restart request. Operator command authorization is unchanged. API inference
credentials do not gain a new privileged restart endpoint.

The host immediately fences new input and stops periodic producers. Dispatcher,
review workers and report-processing owners are told to stop concurrently. Active
turns receive a bounded grace period, then checkpoint/abort; queued work, manual
pause flags, original task identities, deadlines and uncertain-effect receipts
remain durable. Delivery failures do not cause the command to wait indefinitely.
All shutdown phases, snapshot retries and cleanup share **one absolute budget**:

```yaml
lifecycle:
  restartTimeoutSeconds: 60  # default; integer 1..3600
  agentRestart: false       # true grants standing restart authority to model turns
loop:
  drainSeconds: 60          # upper bound on turn grace, clipped to total budget
```

The total budget includes reserved checkpoint/cleanup time, not a fresh 60 seconds
for every component. The process owner never releases the Home lock while the old
runtime can still write. If the final checkpoint cannot be confirmed, shutdown
reports failure and retains the previous durable inbox rather than claiming that
new work was saved. A restart budget is not a guarantee of provider/network
readiness by that exact deadline.

The foreground launcher stays outside the runtime and waits for its exit before
starting the replacement. Exit75 requests a restart. Direct `node dist/cli.js run`
and `npm start` establish the same owner, so a native service with `Restart=no` or
launchd `KeepAlive=false` still supports `/restart`. Supervisor SIGTERM stops the
owner and its runtime without respawning during a pointer handoff. Disconnecting
from the owner checkpoints gateway work too; it is not a user cancellation.

## Native source updates

Native installations enable hourly checks and automatic installation by default:

```yaml
softwareUpdates:
  enabled: true
  autoInstall: true
  checkEverySeconds: 3600
  sources:
    core:
      repository: https://github.com/hayate-agent/core.git
      branch: main
    plugins:
      repository: https://github.com/hayate-agent/plugins.git
      branch: main
    webui:
      repository: https://github.com/hayate-agent/webui.git
      branch: main
```

Mutating tool calls require the active authenticated operator conversation, or
standing authority from trusted configuration: automatic installs when enabled,
and autonomous model restarts only with `lifecycle.agentRestart:true`. API-only
and foreign worker turns cannot borrow another conversation's operator authority.

These are trusted per-agent installation settings, not model-writable local
settings. Git uses the operator's existing credential/SSH helper; URLs containing
HTTP credentials or command fragments are rejected. No token is included in
status messages. Git/npm run without a shell and have finite deadlines.

For internal deployments override **all three** sources explicitly, for example:

```yaml
softwareUpdates:
  sources:
    core: {repository: 'https://git.vanillacore.net/harness/core.git', branch: main}
    plugins: {repository: 'https://git.vanillacore.net/harness/plugins.git', branch: main}
    webui: {repository: 'https://git.vanillacore.net/harness/webui.git', branch: main}
```

The external foreground owner does the source/build work, not a Main or Dispatcher
turn. Commands return a durable scheduling receipt before installation can stop
the requesting turn. A busy task, ongoing monitor or queued job is not an update
admission dependency. The first scheduled check occurs after the configured
interval; `/update check` checks immediately.

- `/update status` includes software status and local-overlay status.
- `/update status software` inspects only the external native owner.
- `/update check` checks sources and reports availability without installing.
- `/update install` prepares, validates and requests a bounded durable restart.
- `/update apply skills|cron|all` retains its local-overlay behavior.
- `plugin_software_update` exposes `status`, `check`, `install`, and `restart` for
  operator-authorized agent maintenance; agents need not invent shell updaters.

A software notice goes to the configured/persisted home address (and local log).
With `autoInstall:false`, the notice asks for `/update install`. Disabling automatic
installation does not disable an explicitly approved install. With `enabled:false`
no new code preparation is scheduled. Prepared automatic updates do not gain
operator approval merely from a process restart or a policy change.

### Preparation and selection

All three exact Git heads are captured as one plan, cloned into a new private
`<home>/software-updates/releases/<id>` installation and checked out by exact
revision. Existing operator worktrees, dirty files, credentials and agent state
are never updated/reset/deleted. Core and WebUI dependencies are installed and
built. Runtime entrypoints and required native dependencies are checked locally.
Development test suites run in release CI, not inside the agent's updater and
not as a prerequisite for a restart.

Core's immutable bundled-plugin hashes remain authoritative. Internal sources can
fetch their locked Plugins revisions; public fresh-history snapshots use Core's
vendored, hash-locked plugin/asset sources instead of trying to fetch private
ancestry from GitHub. The independent latest Plugins checkout is retained as part
of the installation. Neither lock is silently rewritten.

Only after validation does the owner request restart. **Only after the old runtime
exits** does it commit `selected.json` and start Core from that installation.
The selection includes all three component paths/revisions for consumers. A
separately supervised WebUI service or custom external plugin module must use the
selected installation in its own launch configuration; this mechanism does not
silently rewrite or restart unrelated services. Core's bundled plugins are active
with the replacement Core process.

Preparation/status receipts survive owner restart. Interrupted preparation may be
retried in a fresh private directory; prepared code is not rebuilt blindly. A
failed build does not change the active selection and does not create a permanent
busy hold: a later explicit install or scheduled check can retry. An external
service owner replacing the base installation supersedes a selector bound to the
old base, preventing an old self-update from pinning/downgrading that replacement.
Source installs report the package version and exact Git revision; they do not
invent a published release number for an untagged branch head.

## Containers and existing deployment owners

Containers keep native Git/npm installation disabled: their image belongs to
GitOps or another deployment owner. `/restart` still restarts the runtime inside
the existing image. An operator can explicitly disable native checks for an
externally maintained native installation as well.

The passive authenticated capabilities include `features.durable_shutdown` and
`lifecycle.restart_timeout_seconds`. Existing authorized Linux/macOS service owners
can use the runtime's bounded SIGTERM checkpoint instead of demanding that all
business work become idle first. They still verify agent identity, exact unit/PID,
old-owner exit and publication/readiness. Unknown/legacy runtimes retain their
existing admission/bootstrap protections; no error-message-based bypass, forced
kill, lock deletion or uncertain side-effect replay is introduced.
