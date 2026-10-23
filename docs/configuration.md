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
