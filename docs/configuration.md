# Configuration

Each instance supplies its own configuration; identity and providers are not
hardcoded in the application.

- `VANILLACORE_HARNESS_HOME`: harness configuration, personality and persistent state
  (default `~/.vanillacore-harness`).
- `VANILLACORE_HARNESS_AGENT`: default agent key; `agent` in harness.yaml overrides it.
- `PI_CODING_AGENT_DIR`: PI provider/settings/extension directory.

## harness.yaml

```yaml
agent: example-agent
model: example-provider/example-model
thinking: medium
loop:
  tickMs: 15000
  busyMode: queue
  drainSeconds: 60
memoryGuard:
  percent: 90  # 0 disables; use a meaningful threshold below 100
```

SOUL.md, VOICE.md and optional personalities belong in the harness home. These
files describe identity and tone, not secrets. Every session also receives a generic
Harness foundation: product identity, runtime distinction, task context and truthful
self-development instructions. It does not hardcode a persona or claim unavailable
integrations. SOUL and VOICE add your configured identity and writing style even when
no named personality overlay is selected. Existing live sessions need a restart or
`/new` to receive changed system context. See README for Matrix settings.

## Skill catalog

The Harness maintains a derived index at `<home>/skills/index.json`, owned by the
single Harness process holding that home. It is rebuilt from configured
`skills.paths` (default `<home>/skills`), workspace `.pi/skills`, and the PI agent
`skills` directory, in that priority order. First directory wins on name collisions.
The index stores validated metadata, canonical paths, SHA-256 content hashes,
diagnostics, a schema version and a catalog generation. Body-only edits also change
the generation; unchanged sources preserve it across restarts.

The index is not a source of trusted paths. Each refresh reads the allowed source
roots again; missing or corrupt indexes are rebuilt. Symlinks within a root are
supported, but symlinks escaping that root are excluded. Invalid skills and duplicate
names produce diagnostics in the Harness log. Skill scripts are never executed by
indexing. The index is replaced atomically and refreshes within the process serialize.
Do not edit the index manually or share one writable home between Harness processes.

The catalog reconciles on startup, before slash-command discovery and before each
working model prompt. Existing PI sessions receive current validated skill metadata
through the per-turn system context without reloading extensions or resetting their
conversation. A skill created during a running prompt becomes discoverable on the
next prompt; it can also be read directly immediately. No filesystem watcher is
required. `/reload-skills` remains a manual fallback.

## Built-in review

Changeset review ships enabled by default, with a three-round persistent budget and
configurable reviewer model/reasoning. See [review.md](review.md) for configuration,
False-Positive assessment, operator escalation and publication enforcement limits.

## Available tools

An optional top-level `tools` list selects actual runtime tools, not just prompt guidance:

```yaml
tools: [read, bash, edit, write]
```

Omit `tools` to use runtime defaults. Set `tools: []` for no model-visible tools.
Names are literal (no wildcards or `+`/`-` modifiers); installed extension tools may
also be named. Tool availability is determined when a session opens; restart to apply
changes to existing sessions. This selection is not an OS security sandbox: a bash
or extension tool can provide broader capabilities, and extensions execute trusted code.
MCP and CLI lifecycle management are not implemented by this setting.

## Models and credentials

Provider definitions live in PI's `models.json`; examples are in
`deploy/kubernetes/models.json`. Choose the actual endpoint and model IDs, and
reference credentials by environment name, for example `"apiKey": "$MODEL_API_KEY"`.
The secret is supplied to the process, not embedded in Git or the image.
API authentication uses a separate `API_SERVER_KEY`. Do not reuse a model key.

The run API accepts configured `provider/model` references or unambiguous bare
model IDs. A supplied provider must match the resolved model. Per-run model and
reasoning choices do not replace the configured provider credentials.

MCP management, installable-tool manifests and self-modifying runtime version
activation are future work, not settings currently implemented by this release.
