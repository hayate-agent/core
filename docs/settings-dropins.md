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
historical per-field salvage of `settings.local.yaml`, including on reload.
An empty `settings.d/` explicitly opts into strict startup validation.

Reload preserves the existing activation contract: reasoning-effort opt-ins and
dispatcher rules are live; other file edits are startup-bound. `effective()` and
`snapshot()` describe active values, not the desired disk state.
`restartPending` lists changed startup-bound categories and diagnostics explicitly
say that a restart is required. Deleting a startup-bound setting also remains
pending until restart. No restart or deployment is performed by this feature.

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
| model/thinking, review model/thinking | restart pending; existing session choices preserved | `/settings` publishes only selected field; session model precedence unchanged |
| reasoning-effort compatibility | live at provider request | settings validation |
| dispatcher rules | live before worker selection | existing routing boundary |
| dispatcher capacity/enabled/strategy | restart pending | startup only |
| context maintenance, pruning | restart pending | existing context/pruning settings commands publish only explicit fields |
| context/completion/nightly/compaction strategy | restart pending | existing idle strategy managers, no new loader |
| memory | restart pending | existing memory settings/provider/orchestration lifecycle |
| skills paths/context | restart pending | existing skills lifecycle; no automatic extension reload |
| gateways, gateway/policy/extension plugin maps | restart pending | existing idle managers; no automatic module import on disk edit |
| persona | live, whole last-good prompt on invalid edit | `/personality` remains explicit legacy selection |

This deliberately does **not** claim every startup-bound value is hot-reloadable.
Desired disk values are validated together, active values remain truthful, and
`restartPending` plus path/category diagnostics identify the required activation.
No restart, deployment, live-config write or extension reload is automated.
`harness.yaml` and arbitrary security/secrets/provider settings are outside this
runtime-writable allowlist. The existing installation defaults remain startup input.
A permitted overlay is not permission to import arbitrary categories.
