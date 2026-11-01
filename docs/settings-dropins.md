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
pruning fields merge by field. Plugin maps merge by plugin ID; a later plugin
spec replaces that ID's entire spec. Gateway overrides merge by gateway ID and
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

This is independent of persona-file overlays. Persona `.d` support and any
changes to persona/runtime/configuration wiring are separate work.
