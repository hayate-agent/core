# Configuration

## Completion provider compatibility change

An explicit `completionCheck` block must set `provider` to a registered provider
name, or to `false` to deliberately disable completion checks. An explicit block
without a provider is a configuration error; an unregistered selected name fails
after plugin activation, before work admission. Registration alone does not select
a provider, and selecting TypeSafe with missing/invalid registration/configuration
never falls back to the LLM judge.

CLI compatibility: existing profiles that omit the **entire optional block** retain
their documented `legacy-llm` baseline. This is profile compatibility, not fallback
after a selected provider fails, and it changes no credential, model, endpoint or
permissions. It prevents an automatic software update from silently removing the
validator from currently working agents before an explicit configuration migration.
New explicit profiles should name their intended provider, for example
`completionCheck: { provider: legacy-llm }`. The strict registry/embedding API has
no implicit selection.

Embedders calling `assessCompletion` must supply a registry with an explicit
selection. Missing or unknown providers reject rather than becoming an
`unavailable` verdict. Authorization/cancellation guards still prevent assessment,
and explicitly disabled checks remain unavailable. Provider runtime failures remain
fail-closed and non-semantic: public task snapshots retain only a bounded `detail`
(cause, allowlisted transport code and HTTP error status), never exception messages,
URLs, prompts or credentials. These diagnostics do not authorize continuation.


## Start with a working profile

For an end-to-end setup, use the [terminal/WebUI/Matrix guide](gateways.md), then
add the optional [dispatcher](gateways.md#4-optional-background-delegation-enable-the-dispatcher).
Core includes a [commented starter YAML](examples/hayate-agent.yaml);
`hayate-agent init --home <home> --cwd /absolute/workspace` creates the same kind of
safe baseline without overwriting existing files. No provider credentials, model
IDs, context lengths or mandatory reasoning levels are prescribed.

`hayate-agent.yaml` owns startup tools/plugins, authority and dispatcher policy.
`settings.local.yaml` owns explicit writable overrides, including `gatewayPlugins`.
`gateways` only controls transport feedback, not activation. Matrix is bundled and
environment-enabled; WebUI is a separately installed local ESM gateway selected
through `gatewayPlugins.webui.module`. Both use normal Harness command/execution
routing; the UI is not Core functionality.

## Native restart and software updates

`lifecycle.restartTimeoutSeconds` defaults to60 and bounds the entire orderly
checkpoint/stop, including active turns and cleanup. It does not wait for all
business tasks, monitors or queued jobs to finish. The foreground owner starts
the replacement only after the old runtime exits.

`softwareUpdates` defaults to enabled hourly checks and automatic native
installation. Configure `sources.core`, `sources.plugins`, and `sources.webui`
with trusted repository URLs/branches in this agent's `hayate-agent.yaml`.
Public defaults are `https://github.com/hayate-agent/{core,plugins,webui}.git`.
Use `autoInstall:false` for explicit `/update install` approval, or
`enabled:false` for an external native update owner. Containers never run native
Git/npm installs. A restrictive `tools` allowlist must include
`plugin_software_update` if the agent should initiate maintenance itself.
See [the lifecycle contract and examples](native-lifecycle.md).

## Main completion validation

The selected completion strategy judges the whole authorized task, including Main
responses, not just delegated worker results. Verified milestones, promised/open
steps and genuine holds are considered separately. A future-tense promise is not
completion. A generated continuation, worker grant or saved plan is not a new human
instruction and cannot invent an operator prohibition or broaden permission.

An independent `continue` admits one concrete next step under the original scope,
stop/expiry, dependency and budget fences. Technical/invalid judgments retain the
settled Main reply for existing bounded assessment retry; they never replay the
productive turn. Genuine semantic uncertainty grants no execution. The prompt
strategy remains replaceable through the existing completion-strategy extension;
no external JEV backend is required by the default LLM implementation.

CLI Main validation has a 30-second default request budget. Configure 1–120 seconds:

```yaml
completionCheck:
  provider: legacy-llm
  timeoutMs: 30000
```

Existing explicit `completionCheck.authorizations` remain supported. The validator
model still uses Validator → Review → Default, without silently replacing an
explicitly selected unavailable model. Restart after changing the timeout.

## Reloading model configuration

Use **`/reload-models`** after editing the provider/model catalog (`models.json`).
This administrator command refreshes local configuration without a model request,
preserves selected model IDs and reasoning settings, and rebinds existing idle
sessions to fresh model metadata at their next turn. This includes API/protocol
changes for the same provider/model ID. Active prompts must finish first. Invalid
configuration fails closed until corrected and reloaded; it never silently falls
back to another model. Queued topic-label inputs are retried without resending.

**`/reload-skills`** and **`/reload-mcp`** reload skills/session resources only;
they do not reload the model catalog or restart the agent.


Each instance supplies its own configuration; identity and providers are not
hardcoded in the application.

- `HAYATE_AGENT_HOME`: configuration, personality and persistent state
  (default `~/.hayate-agent`).
- `HAYATE_AGENT_AGENT`: default agent key; `agent` in hayate-agent.yaml overrides it.
- `HAYATE_AGENT_REASONING_EFFORT_NONE_MODELS`: comma-separated provider/model opt-ins
  for reasoning effort `none`, merged with `reasoningEffortNoneModels` in YAML.
- `PI_CODING_AGENT_DIR`: PI provider/settings/extension directory (third-party PI).

### Home selection

Explicit `--home` wins, then `HAYATE_AGENT_HOME`, then `~/.hayate-agent`.
An explicitly selected directory may have any name; no directory is moved or
deleted. Only `hayate-agent.yaml` is loaded from the selected home. Other home
names, environment aliases and configuration filenames are not discovered.
`init` preserves an existing `hayate-agent.yaml`.

Already-running local agents require a separate deployment transition before
upgrading: explicitly select their authoritative persistent home and mount their
configuration as `hayate-agent.yaml`. Preserve sessions, memory and pending work
in place; this application does not perform that operational transition.

## hayate-agent.yaml

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
no named personality overlay is selected. See the [gateway guide](gateways.md) for
Matrix credentials/access controls and WebUI activation.

### Composed persona instructions (not alternative profiles)

```yaml
persona:
  # Relative overlay paths resolve against Harness home, never the working repository.
  overlays:
    - personalities/example-delivery.md
  # Optional: all direct .md children, ordered by filename; no recursion.
  # overlaysDir: persona-overlays
```

Every explicitly listed file is loaded, followed by every Markdown child of the
explicit directory. There is no selection and no file-count limit. List order,
then filename order, is stable; duplicate absolute paths load once. By default,
`SOUL.md.d/` and `VOICE.md.d/` beside the configured base files append all direct
`.md` children in lexical filename order (1 or 50 files, no limit). Base identity
and voice remain present. `personalities/` remains the legacy alternative-profile
store, loaded only by an explicit `/personality name`. To migrate the already
written `personalities/example-delivery.md`, add the `overlays` entry shown above;
do not select a profile or copy other agents' SOUL/VOICE files. An operator may
instead explicitly designate a directory as overlays after verifying that **all**
its Markdown files are their own cumulative instructions. YAML/technical settings
are never inferred as prompt content; overlay Markdown must contain instructions,
not secrets. Config changes still require the normal configuration activation;
this implementation does not hot-reload hayate-agent.yaml.

Prompt order is foundation, own SOUL, own VOICE, optional legacy selected profile,
ordered overlays, conversation guidance, skill metadata and current run instructions.
Overlays supplement the configured agent key/name and VOICE; they are not a new
identity selector or authorization source.

After configuration activation, the complete set is reread at the next model call
in **existing** conversations and managed/dispatcher workers, including continuation
and tool iterations. Additions, edits and deletions take effect without `/new`,
transcript replay or restart. In-flight provider requests are not changed. Read-only
ephemeral reviews intentionally have no working-agent persona. Native and external
session storage use the same refresh path. PI 1.4 requires a small version-pinned
adapter bridge to update both owned prompt snapshots; its normal structured system
patches preserve user/assistant/tool history. Other runtime adapters must implement
this next-call contract rather than caching instructions at session creation.

Invalid UTF-8, symlinks or nonregular files produce an actionable path diagnostic.
Initial invalid persona loading fails; after a complete baseline, invalid edits retain
the **whole** last good prompt and the next call continues safely, allowing repair.
Removing a configured file, directory or child intentionally restores lower layers;
a missing base SOUL/VOICE retains legacy optional-file semantics. No watcher, new
permission state, arbitrary size/count cap or automatic repository Markdown scan
is introduced. The model's context limit still applies. This is trusted local
operator configuration, not a sandbox against an operator replacing parent paths.

## Dispatcher model routing rules

The dispatcher executes operator-authorized worker tasks. With the built-in `direct`
strategy, workers can route to different models per task through `dispatcher.rules`.
Each rule has an optional `match` (task classification) plus a required `model`
(`provider/model`) and an optional `thinking` level. The first matching rule wins;
a rule with an empty `match` is the fallback and must be the last rule. At most one
fallback is allowed. Without a matching rule (and without a fallback rule) workers
use the session model. `match` supports `minChars`/`maxChars` (task brief length),
`keywords` (case-insensitive substrings) and `regex` (unanchored, applied to the task
brief). At most 8 rules are allowed.

```yaml
dispatcher:
  enabled: true
  strategy: direct
  concurrentRequests: true
  capacity: 2
  retentionDays: 7
  rules:
    - match: {minChars: 1200}   # complex task briefs -> model A
      model: example-provider/big-model
      thinking: medium
    - match: {}                 # simple tasks -> model B (fallback)
      model: example-provider/small-model
      thinking: off
```

Rules are validated on startup and through `settings.local.yaml` overlays (the
`dispatcher` key accepts `rules` too). `dispatcher.rules` is one of the live-editable
overlay keys: an overlay update applies at the next worker dispatch boundary without
restart. Rules apply only to dispatcher worker turns;
the parent agent keeps the session model. Reasoning levels above `off` require models
that handle `reasoning_content` correctly; models listed in
`HAYATE_AGENT_REASONING_EFFORT_NONE_MODELS` or `reasoningEffortNoneModels` are exempt for
`thinking: off` turns.

## Reasoning effort none opt-in

Some OpenAI-compatible servers only accept `reasoning_effort: "none"` instead of a
thinking switch. Opt in models verified to accept that parameter via
`reasoningEffortNoneModels` in `hayate-agent.yaml` (preferred, config-owned) or the
`HAYATE_AGENT_REASONING_EFFORT_NONE_MODELS` environment variable; both lists are merged:

```yaml
reasoningEffortNoneModels:
  - homelab/deepseek-v4-flash
```

For opted-in `openai-completions` models, a per-turn thinking `off` injects
`samplingParamsByThinkingLevel.off.reasoning_effort = "none"` into the selected
model and restores the original selection after the turn. Changing `hayate-agent.yaml`
requires a restart or `/restart`; a `settings.local.yaml` overlay with the same key
(`reasoningEffortNoneModels`) is live-editable and applies at the next request
boundary, merged with the config and environment lists.

## Skill catalog

The Harness maintains a derived index at `<home>/skills/index.json`, owned by the
single Harness process holding that home. It is rebuilt from configured
`skills.paths` (default `<home>/skills`), workspace `.pi/skills`, the Agent Skills
project location `.agents/skills` (discovered from the workspace ancestors), and
the PI agent `skills` directory, in that priority order. First directory wins on
name collisions.
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

Skill metadata injection is configurable via `skills.context` (hayate-agent.yaml) or
`skills.context` in `settings.local.yaml`:

- `auto` (default): inject the catalog metadata once per session, cached; the
  leading prompt prefix stays byte-stable across turns, so prompt/prefix caches
  are reused. Cache is invalidated whenever skills reload.
- `lazy`: inject nothing; the model discovers skills on demand through the
  `plugin_skill_search` tool (names + descriptions only).
- `off`: inject nothing; no search tool injection beyond `lazy`.

With `lazy`/`off`, a skill created during a running prompt stays invisible until
its metadata would be needed; the search tool reads the live catalog on each
query, so late-discovered skills are usable without a session restart.

## Built-in review

Changeset review is disabled by default, with no mandatory local/publish/merge gates.
When explicitly enabled, it offers a three-round persistent budget and
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

## Chat model settings

Core commands (global changes require administrator rights):

- `/model provider/model`: change only this session; `/model` shows it.
- `/reasoning medium`: change only this session.
- `/model provider/model --global`: persistent default for this Harness instance.
- `/reasoning medium --global`: persistent reasoning default for this instance.
- `/review-model provider/model`: persistent reviewer model; without arguments shows the effective value.
- `/review-reasoning medium`: persistent reviewer reasoning; without arguments shows it.
- Use `reset` instead of a value on the global/reviewer commands to remove the chat override.
- `/model --global` and `/reasoning --global` show the effective defaults.

Chat overrides live in `<home>/settings.local.yaml`, not `state.json` or the
potentially read-only `hayate-agent.yaml`. Only explicit overrides are stored, not a copy
of all defaults. Setters validate and serialize updates, atomically save, then publish
the new effective values. Output identifies whether a value comes from the local
overlay or installation/default. `--global` must be the final argument.

Precedence is product defaults, installation configuration, persistent local overlay,
session selection, then per-run overrides (more specific wins). A new global change
reapplies working defaults on the next turn; later session selections remain local.
The current writable allowlist covers model/reasoning and reviewer model/reasoning.
Unknown keys, secrets, plugin paths and security policy are rejected, not merged.

### Live routing and request compatibility overlay

The existing `<home>/settings.local.yaml` is the writable surface above the
installation's (possibly root-owned/read-only) `hayate-agent.yaml`. No base write,
permission change or restart is needed for these two live keys:

```yaml
dispatcher:
  rules:
    - match: { minChars: 1200 }
      model: homelab/glm-5.3-flash
      thinking: off
    - match: {}
      model: homelab/deepseek-v4-flash
      thinking: off
reasoningEffortNoneModels:
  - homelab/glm-5.3-flash
  - homelab/deepseek-v4-flash
```

Rules and the model list replace their base arrays (not append); omitted keys
inherit the base and `[]` explicitly clears an array. The legacy environment
model opt-ins remain additive for compatibility; removing an overlay opt-in does
not remove an environment opt-in. Model availability/credentials must already be
configured. This list does not change authentication or enable dispatcher access.
The installation must already grant/enable dispatch and concurrency.

Before each future dispatcher worker the host reads and validates the complete
file, then selects routing. Before each future PI prompt (including tool-free
review requests) it does the same for request compatibility options. Inflight
requests retain their captured model metadata; already queued worker turns keep
the routing chosen when accepted. Explicit conversation model/thinking selections
are not rewritten. Only `thinking: off` on listed `openai-completions` models
injects `reasoning_effort: none`; other APIs, other models and explicit non-off
thinking are unchanged. This is a provider compatibility opt-in, not a claim
that every endpoint supports `none`.

Save the file atomically. A successful file save is not activation: the next
worker/prompt boundary must validate it. Startup and reload are tolerant: valid
supported fields apply alongside invalid, unknown or forbidden fields. Ignored
fields retain their previous valid value on reload and inherit the installation
base at startup. Diagnostics are bounded (20 messages, 240 characters each), name
fields but never include values or YAML excerpts. Non-live edits (including
removals) are ignored individually until restart; legitimate startup fields still
work. Malformed YAML or a non-object document retains the whole previous snapshot
(base at startup), without an overlay-only startup failure. Correcting the durable
file recovers at the next boundary. An absent file is supported.

Routing arrays are deliberately validated as a whole: a rule's match/model/thinking
is indivisible, and filtering a bad earlier rule could silently route its traffic
to a later fallback. Any invalid rule or invalid ordering therefore retains the
previous routing array (base at startup), without blocking other valid fields.
Model opt-in entries are independent: valid entries retain their order, invalid
entries are ignored; a nonempty all-invalid list retains the previous array.
An explicit `[]` clears either array, and omission restores base inheritance.
Other settings retain their existing command/startup semantics; external edits to
them are not hot-applied by this mechanism. In particular grants, tools, approvals,
authentication, trust pins and secrets cannot be changed through these live keys.
The same mechanism works in containers and local installations under Harness home.

Example local overlay:

```yaml
model: homelab/gpt-6.1-sol
thinking: medium
review:
  thinking: high
```

`reset` deletes the relevant key and restores inheritance. The overlay is loaded at
startup; external manual edits require restart. Working defaults take effect next
turn, reviewer settings next call, without interrupting in-flight work. The reviewer
uses its explicit model override/configuration, otherwise the global working model;
reviewer reasoning defaults to medium independently of working-session reasoning.
Model setters validate availability against the runtime registry before saving.

Global working defaults apply to existing sessions at their next turn and to new
sessions. Active turns are not interrupted. A later session-specific `/model` or
`/reasoning` remains in force until another global change occurs. Reset restores
the configured fallback; if no model/reasoning fallback exists, existing sessions
retain their current setting and new sessions use the runtime default. Reviewer
changes apply on the next review call; an in-flight review keeps its original model.
These settings affect this Harness instance only, not other agents or GitOps files.

## Scheduled jobs: local configuration ownership

Cron job definitions are operator-owned configuration, not an immutable job catalog
bundled with the Harness. The scheduler reads `cron.jobsFile`, defaulting to
`<home>/cron/jobs.yaml`. This file is the authoritative editable definition source;
there is no second local job-definition merge layer or automatic baseline restore.
Installation tooling may provision the file separately; the scheduler does not
infer its ownership or merge upstream definitions into it.

After editing definitions, `/cron reload` prepares the replacement schedule before
publishing it. Invalid YAML or schedules retain the previous active schedule.
Removing definitions removes them on reload; a missing jobs file clears the
schedule. Scripts and prompt files remain resolved relative to the configured
jobs directory, with the existing script containment checks.

`/cron pause <name>` and `/cron resume <name>` are administrative operations. Their
name-based enabled overrides are saved with Harness state and survive restart;
they override the definition's `enabled` value. These switches are not definition
backups and do not restore deleted jobs. To restore a definition, edit or restore
the operator-owned source file and reload it. Updating definitions does not grant
additional authority to their follow-up work.

This single editable source plus atomic reload and persistent enable overrides is
the supported Cron lifecycle. It deliberately differs from components that need
an immutable installation baseline and a separate local replacement overlay.

## Models and credentials

Provider definitions live in PI's `models.json`. The public repository does not
include a model configuration bundle; create one for your provider using
[PI's model configuration reference](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md).
Choose the actual endpoint and model IDs, and
reference credentials by environment name, for example `"apiKey": "$MODEL_API_KEY"`.
The secret is supplied to the process, not embedded in Git or the image.
API authentication uses a separate `API_SERVER_KEY`. Do not reuse a model key.

For native HTTPS on the run API, set both `API_SERVER_TLS_KEY_FILE` and
`API_SERVER_TLS_CERT_FILE` to mounted PEM files. A missing pair, unreadable files
or invalid TLS material fails startup; there is no fallback to HTTP when TLS is
configured. Without these settings the existing HTTP mode is preserved. TLS does
not replace the bearer key. Certificates are loaded at startup, so renewal
requires a controlled restart. Clients must trust the issuing CA and verify the
endpoint hostname; never disable certificate verification.

The run API accepts configured `provider/model` references or unambiguous bare
model IDs. A supplied provider must match the resolved model. Per-run model and
reasoning choices do not replace the configured provider credentials.

MCP management, installable-tool manifests and self-modifying runtime version
activation are future work, not settings currently implemented by this release.
