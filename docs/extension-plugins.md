# Runtime extension modules (API1)

Trusted local modules can be added, replaced or removed at an instance-wide idle
boundary using admin-only `/extension-plugin`:

- `status`
- `use <id> <path>`
- `reload <id>`
- `disable <id>`
- `remove <id>`

Desired selections persist under `extensionPlugins` in settings.local.yaml. Paths
resolve against Harness home. Removing a selection unloads that managed module;
there is no implicit bundled baseline and no mutation of startup plugin files.
Desired state remains saved on activation failure; repair before restart. Invalid
initial desired state fails startup rather than silently disappearing.

The module default exports the existing `{apiVersion:1, activate(api)}` contract.
Only registerCommand, registerPanel, registerPolicy and onStop are permitted.
Unsupported registration APIs throw immediately. Do not start external receivers
or irreversible effects in activate. Register cleanup for every owned resource.
These modules are trusted process code, NOT a sandbox; factories can access files
and credentials. Other registration types (tools/channels/compactions/providers/
orchestrators/dispatchers) must use their existing startup/specialized lifecycle.
They hold external references that this manager cannot safely revoke.

Preparation uses an isolated PluginHost. Builtin/startup command, panel and policy
identities cannot be shadowed; required policies cannot be supplied or removed.
The manager checks generation ownership before synchronous publication. Failed
preparation retains the previous selection. Later policy replacement by a different
owner is never undone by stale module cleanup. Do not combine managers to control
the same identity; overlapping ownership causes activation rejection.

Command and optional-policy calls pin their generation until settlement. Replacing
or removing the module prevents new calls to the retired generation and waits for
existing calls before cleanup. Retired command delegates reject new calls; retired
panels render empty. Synchronous panels need no asynchronous lease. Status exposes
active/pending/retiring and sanitized errors, never module exception text. Cleanup
failure sets degraded status, blocks further activation and remains visible at
shutdown; restart/operator recovery is required. It is not silently retried because
cleanup may be non-idempotent. Resources whose cleanup failed are not claimed freed.

Shutdown drains Harness turns first, closes manager admission, waits for candidate
preparation and all leases, removes its registrations, then stops general plugins.
There is no forced termination of hung trusted activation/calls/cleanup. An entry
import is cache-busted, dependencies remain cached and Node does not unload ESM.
Use versioned directories; this is not unlimited reload or package installation.
Build/merge does not activate deployments. Commands/panels/policies are dynamically
routed; this is intentionally not universal hot replacement of SDK-bound tools or
provider/channel consumers.
