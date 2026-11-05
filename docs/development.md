# Developing and extending Hayate Agent

This guide ships with the installed package and image. It describes this version,
not a promise that every planned interface is already implemented. `/harness`
locates it. PI is a replaceable runtime adapter, not the product's identity.

## Architecture: behaviour belongs in extensions

**Behaviours should be expressed via either plugins or codified extensions.
The core should remain clear and clean.** Core provides lifecycle, routing,
persistence and explicit extension contracts; concrete behavioural policies belong
in plugins or codified extensions rather than unconditional Core prompt text.
Operator-specific working rules belong in the operator-managed SOUL.md. Prefer
existing extension points; introduce a Core hook only when the required capability
cannot be expressed through them. This principle does not remove infrastructure
correctness checks or external access controls.

## Default working rule: vertical slices and KISS

The default CLI supplies **ALWAYS vertical slices. ALWAYS KISS.** through
`capabilityContext` on every working turn, including dispatcher and managed
subagent workers. It is independent of persona files, memory, skill discovery,
tool selection and dispatcher enablement. Core owns this shared instruction path;
[hayate-agent/plugins](https://github.com/hayate-agent/plugins) owns the dispatcher tool adapter, which has no instruction hook.

Build the smallest simple end-to-end slice from the concrete request to a verified
result before expanding horizontally. Include persistence, restart, continuation
and activation when relevant and authorized. Avoid speculative abstractions,
additional state machines and approval loops; justify added complexity with the
request and evidence. Tests, merge and image builds are intermediate evidence,
not proof of live completion. Review and approval working rules belong in the
operator-managed SOUL.md, not in Core's unconditional working instructions.
The separately configured review engine and external repository policies remain
independent mechanisms; this shared default does not establish a review obligation.
Always make small focused changes and small PRs: one purpose per PR,
independently deployable increments and explicit real dependencies. Do not batch
unrelated fixes, hold ready fixes for unrelated work, or ship unusable horizontal
fragments. This shared default preserves required CI and grants no automatic
rollout permission. This is a model instruction, not mechanical correctness enforcement.

Activation requires shipping the rebuilt Core package/image through the authorized
rollout and restarting the process; source edits and local builds do not alter a
running deployment. The new process supplies the rule at the next working turn,
including resumed sessions. No persona rewrite, plugin pin or state migration is
needed. Embedders constructing `Harness` directly must supply the instruction
context themselves, as with the other CLI capability instructions.

## Local targeted tests and integration checkpoints

Use `npm ci --include=dev` in your own checkout (development tools are needed even
when the shell has `NODE_ENV=production`). Run `npm test` for the complete suite:
it builds the required runtime files first and uses a canonical, short temporary
directory (important for macOS symlinks and Unix socket path limits). Local-memory
worker tests require `flock` on PATH: Linux util-linux or macOS `brew install flock`.
The lock is acquired on an inherited descriptor before the worker is executed.
For each local vertical slice, run the relevant tests and `npm run typecheck`;
a full suite is not required after every edit.

```sh
npm run test:targeted -- --list                  # explain selection, no execution/network
npm run test:targeted                           # staged + unstaged + untracked vs HEAD
npm run test:targeted -- --base origin/main      # candidate changes vs a chosen base
npm run test:targeted -- src/capability-context.ts  # explicit repo-relative changed files
npm run test:targeted -- test/test-targeted.test.ts # selector's own causal tests
```

The command prints the mode, reason and test files before running them. It follows
literal relative imports transitively, including re-exports, type-only imports and
literal dynamic imports; it is a local heuristic, not a complete runtime dependency
model. Computed imports, subprocess/fixture protocols and implicit runtime coupling
are not inferred. Include all changed files (the default does this), and add explicit
regression tests for such contracts; do not treat an explicit subset as candidate-wide
validation. Comments/string examples can conservatively over-select.

Known shared/runtime contracts (`src/types.ts`, `src/config.ts`, `src/cli.ts`,
`src/plugins.ts`, generated built-in plugins) select the **full** suite. Unknown,
non-module, deleted, dependency/lock/config/documentation changes, or a changed
module without reachable tests also select the **full** suite with an explicit
reason. There is no silent fallback to zero tests. An actually clean tree reports
`none`; Git errors fail closed. `--list` is safe for previewing costly fallbacks.
Actual execution keeps the existing plugin-materialization prerequisite and test
failure exit status. The normal `npm test` command and all existing gates stay intact.

At regular branch integration/owner-review checkpoints and in required CI before
merge/image promotion, run **`npm run typecheck` and `npm test`** for the complete
candidate, plus the existing build/image checks. Targeted green tests are not a
replacement for those checkpoints. Preserve full-suite CI; diagnose failures
separately rather than skipping gates or claiming a full-suite pass from a subset.
CI/image pipeline and schedule ownership is external to this source tree (there
are no checked-in CI workflows here). This selector adds no image pipeline,
schedule, or deployment configuration. Any periodic full-suite change belongs to
the existing pipeline owner after checking its schedules, not to a duplicate local
pipeline. A source edit does not activate a running Harness.

## Choose the smallest customization boundary

| Need | Existing surface |
|---|---|
| Identity, role, duties | Harness home SOUL.md; no product-code change |
| Tone | VOICE.md and personalities/*.md |
| Model/provider | hayate-agent.yaml model + PI models.json/auth, local /model and /login |
| Exposed tools | hayate-agent.yaml tools: literal names, [] disables model-visible tools |
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
Use a user-owned checkout of https://github.com/hayate-agent/core.git on a
feature branch; published source is available on `main`. Never use root to
overwrite an immutable installation. Deployment
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
