# Typed local settings drop-ins

`SettingsService` reads `settings.local.yaml`, followed by the direct `.yaml` and
`.yml` files in the sibling `settings.d/` directory, sorted lexicographically by
filename. Later values win. There is no file-count limit, recursive discovery,
watcher or new reload boundary: the existing safe settings reload reads the files.
Installation defaults remain immutable. Removing a layer restores inheritance on
the next reload (or next startup for startup-bound values).

Supported categories are model/thinking, review model/thinking,
reasoningEffortNoneModels, dispatcher configuration/rules, contextMaintenance,
toolResultPruning, completion/nightly/context/compaction strategy selections,
memory, skills paths/context, gateways, gatewayPlugins, extensionPlugins and
policyPlugins. Existing validators and allowed values apply; this is not an
arbitrary configuration overlay or a secrets store.

Arrays replace rather than concatenate (including dispatcher rules, skills paths,
and reasoning-effort opt-ins). Review, dispatcher, memory, skills, maintenance and
pruning fields merge by field. Plugin maps merge by plugin ID and typed entry field; disabling/re-enabling
an entry retains its module from a lower layer. Gateway overrides merge by gateway ID and
field, retaining the existing gateway configuration semantics. This deliberately
is not a generic recursive deep merge. `null` strategy disabling remains supported
where the corresponding setting permits it.

With `settings.d/` present, all files form one strict transaction. A malformed,
invalid, unreadable or non-regular file leaves the last good active snapshot
unchanged and reports its path, without echoing file contents. Symlink files and
a symlink directory are rejected. These are trusted operator-owned directories,
not a hostile-filesystem sandbox. Legacy startup without `settings.d/` retains
historical per-field startup salvage of `settings.local.yaml`; invalid live edits retain the whole last-good snapshot.
An empty `settings.d/` explicitly opts into strict startup validation.

Model/thinking defaults, review model/thinking, reasoning-effort opt-ins and dispatcher rules are live. Model defaults refresh before the next regular prompt; explicit session choices retain independent per-field precedence. Review defaults refresh at tool, command and automatic finish entry, before the attempt captures its arguments; in-flight calls retain their captured values. Removing overrides restores installation defaults/fallbacks. Validated gateway,
policy and extension plugin map changes enqueue the existing lifecycle managers;
their timers apply at an idle boundary, never by waiting inside a provider request.
Unchanged entries do not reload. Removing an entry restores the captured policy or
configured gateway baseline, or removes a dynamic extension. Required policies
cannot be disabled. `effective()` and `snapshot()` publish a plugin entry only
after successful activation; `desired()` includes pending/failed desired entries.
Manager status reports pending/errors/degraded cleanup. An attempted failure does
not hot-loop imports: change the desired entry or use the explicit plugin reload
command to retry. Other categories remain startup-bound. `restartPending` includes
unapplied plugin maps as well as startup-bound categories. No restart or deployment
is performed.

Existing `/settings`-backed mutations edit only `settings.local.yaml`, never copy
merged drop-ins into that file and never rewrite drop-ins. They recompute the
higher-precedence layers before publishing the result. Existing command replies
read the effective value, so an overridden local write is not reported as active.
An unrelated mutation does not activate pending startup-bound file edits.

Persona uses the same next-safe-call principle via `SOUL.md.d/` and
`VOICE.md.d/`, plus explicitly configured Markdown overlays; see configuration.md.

## Activation inventory (actual contract)

| Category | Disk additions/edits/deletions at next safe call | Explicit command boundary |
| --- | --- | --- |
| model/thinking, review model/thinking | live before prompt/review entry; existing explicit session choices preserved | `/settings` recomputes live defaults; session model precedence unchanged |
| reasoning-effort compatibility | live at provider request | settings validation |
| dispatcher rules | live before worker selection | existing routing boundary |
| dispatcher capacity/enabled/strategy | restart pending | startup only |
| context maintenance, pruning | restart pending | existing context/pruning settings commands publish only explicit fields |
| context/completion/nightly/compaction strategy | restart pending | existing idle strategy managers, no new loader |
| memory | restart pending | existing memory settings/provider/orchestration lifecycle |
| skills paths/context | restart pending | existing skills lifecycle; no automatic extension reload |
| gateways | restart pending | existing gateway settings commands |
| gateway/policy/extension plugin maps | changed/removed entries queued, applied at idle; failures retain previous active selection | existing plugin commands, same effective file precedence |
| persona | live, whole last-good prompt on invalid edit | `/personality` remains explicit legacy selection |

This deliberately does **not** claim every startup-bound value is hot-reloadable.
Desired disk values are validated together, active values remain truthful, and
`restartPending` plus path/category diagnostics identify the required activation.
No restart, deployment or live-config write is automated. Plugin map edits explicitly
request trusted local module activation; editing module source without changing a
map entry still requires an explicit reload command.
`hayate-agent.yaml` and arbitrary security/secrets/provider settings are outside this
runtime-writable allowlist. The existing installation defaults remain startup input.
A permitted overlay is not permission to import arbitrary categories.
