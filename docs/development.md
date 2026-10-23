# Developing and extending VanillaCore Agent Harness

This guide ships with the installed package and image. It describes this version,
not a promise that every planned interface is already implemented. `/harness`
locates it. PI is a replaceable runtime adapter, not the product's identity.

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
| Harness commands, channels, lifecycle | source modules below; native plugin API not shipped yet |
| Install/manage MCP/CLI tools | managed lifecycle not shipped yet; do not invent settings |

PI extensions are runtime-specific trusted code, not a substitute for a future
Harness-native plugin API. Native plugin interfaces must expose stable contracts
rather than internals, support lifecycle cleanup and explicit registrations, and
not add a second model loop. See roadmap.md for outstanding requirements.

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
