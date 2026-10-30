# Developing and extending VanillaCore Agent Harness

This guide ships with the installed package and image. It describes this version,
not a promise that every planned interface is already implemented. `/harness`
locates it. PI is a replaceable runtime adapter, not the product's identity.

## Default working rule: vertical slices and KISS

The default CLI supplies **ALWAYS vertical slices. ALWAYS KISS.** through
`capabilityContext` on every working turn, including dispatcher and managed
subagent workers. It is independent of persona files, memory, skill discovery,
tool selection and dispatcher enablement. Core owns this shared instruction path;
`harness/plugins` owns the dispatcher tool adapter, which has no instruction hook.

Build the smallest simple end-to-end slice from the concrete request to a verified
result before expanding horizontally. Include persistence, restart, continuation
and activation when relevant and authorized. Avoid speculative abstractions,
additional state machines and approval loops; justify added complexity with the
request and evidence. Tests, merge and image builds are intermediate evidence,
not proof of live completion. Safety, authorization and required review remain
unchanged. This is a model instruction, not mechanical correctness enforcement.

Activation requires shipping the rebuilt Core package/image through the authorized
rollout and restarting the process; source edits and local builds do not alter a
running deployment. The new process supplies the rule at the next working turn,
including resumed sessions. No persona rewrite, plugin pin or state migration is
needed. Embedders constructing `Harness` directly must supply the instruction
context themselves, as with the other CLI capability instructions.

## Choose the smallest customization boundary

| Need | Existing surface |
|---|---|
| Identity, role, duties | Harness home SOUL.md; no product-code change |
| Tone | VOICE.md and personalities/*.md |
| Model/provider | harness.yaml model + PI models.json/auth, local /model and /login |
| Exposed tools | harness.yaml tools: literal names, [] disables model-visible tools |
| Reusable task instructions | skills/<name>/SKILL.md with name/description frontmatter |
| Scheduled work | cron/jobs.yaml and /cron; /goal, /heartbeat, /loop for persistent work |
| PI tools/providers/hooks | PI extensions in its configured agent/project directories |
| Harness commands, channels, tools, text panels and lifecycle | configured local ESM plugins, API v1; see plugins.md |
| Interactive UI dialogs/widgets | local plugin command context.ui; see plugins.md |
| MCP servers | opt-in PI-backed MCP via mcp.enabled; see mcp.md |
| Install/manage CLI tools | managed install lifecycle not shipped yet; do not invent settings |

PI extensions are runtime-specific trusted code, separate from Harness-native
plugins. API v1 exposes explicit command/channel/tool/text-panel registration and lifecycle cleanup without
access to internal Harness objects or a second model loop. See plugins.md for the
contract and roadmap.md for outstanding deployment and integration requirements.

## Source map

- src/cli.ts: shared TUI/gateway startup, state restoration, scheduler and shutdown.
- src/harness.ts: the sole turn/queue/goal/heartbeat authority and durable transitions.
- src/channels/tui.ts: fullscreen terminal layout/editor, dialogs, event display;
  normal input goes to Harness.accept. Change this for the Harness UI, not PI themes.
- src/channels/: channel implementations; src/types.ts defines the Channel contract.
- src/runtime/pi.ts: PI SDK adapter, tool/model/login/extension binding.
- src/persona.ts: generic foundation + per-agent SOUL/VOICE/personality.
- src/config.ts: configuration shape, defaults and validation.
- src/commands.ts: slash-command routing and authorization; responses use the outbox.
- src/delivery/: inbox/outbox/dedup; src/state.ts and durable.ts: persistence.
- src/scheduler.ts: cron lifecycle. src/api/: HTTP/SSE run protocol.
- test/: regression tests; docs/: public operator/development documentation.

## Find a writable checkout

The active project may be unrelated to the Harness. Inspect it before editing.
The installed guide path identifies the package, not ownership or write permission.
Use a user-owned checkout of https://git.vanillacore.net/harness/core.git on a
feature branch. Never use root to overwrite an immutable installation. Deployment
specifics belong in a private overlay, credentials never in either repository.

## Implement and verify

1. Read relevant source and tests. Explain capability gaps instead of assuming APIs.
2. Change the smallest surface; retain a single Harness core for local/gateway work.
3. Run npm ci after dependency changes; direct versions and lockfile are pinned.
4. Run npm run typecheck, npm test, npm run build and inspect the diff.
5. For TUI changes test screen bounds, long output, resize, dialogs and clean exit.
6. For lifecycle changes test replay, queued input, graceful drain and cleanup.
7. Use a normal commit/PR. Main/major branches do not accept direct pushes.

Running processes do not hot-replace imports. A successful build does not activate
it. Finish active work and restart from the tested checkout; describe exactly what
changed and which version is active. Automatic promotion/rollback is not shipped.
A guide cannot prove model behavior: verify actual tool actions and outcomes.

See self-development.md for local workflow and operations.md for recovery limits.

## Conversation model precedence

Explicit `/model provider/model` and `/reasoning level` selections are independent
conversation-local overrides. They survive resource reload and session resume;
unselected fields inherit current installation/global defaults. `--global` changes
instance defaults, not an existing explicit local choice. `reset --global` removes
the instance overlay; `/new` (or `/reset`) starts a conversation without local
overrides. Per-turn API/review overrides do not establish local intent.

The PI adapter records local intent as `harness-session-selection-v1` custom
transcript entries, included in external provider snapshots. Older transcripts
have no reliable provenance: SDK model/thinking entries also represent defaults
and temporary overrides, so they are not automatically treated as local choices.
Reselect once after upgrading to establish intent. Native PI storage still creates
a session file only after a user/assistant message; setup-only empty sessions are
not resumable. External session providers checkpoint selections immediately.
