# VanillaCore Agent Harness

Package and CLI: `vanillacore-harness`.
Repository: `https://git.vanillacore.net/harness/core`.

Agent configuration: `VANILLACORE_HARNESS_HOME` and `VANILLACORE_HARNESS_AGENT`.
The default state directory is `~/.vanillacore-harness`.

Lightweight, persistent personal agent: a general Hermes replacement. PI is the current runtime
(`src/runtime/pi.ts` is the only module that imports the PI SDK).

Status: core loop, Matrix (without E2EE) and a Hermes-compatible HTTP run API are implemented.
E2EE and Web UI are not implemented. MCP/CLI management and self-modifying runtime activation
are planned, not shipped features.

## What it does

- **Loop**: one long-running process. A FIFO queue per conversation (session key); one turn at a time
  per conversation; conversations run in parallel. A periodic tick (`loop.tickMs`) re-enters idle
  sessions for `/heartbeat`, `/loop` and standing `/goal`s.
- **Busy handling** (`/busy`): `queue` (default), `steer` (inject into the running turn), `interrupt`.
- **Persona & voice**: `SOUL.md` (identity) + `VOICE.md` (personality, tone, style; voice in the writing
  sense, not audio) + optional `personalities/<name>.md` (`/personality`). Appended to the system prompt.
- **Skills**: PI's skill discovery (global `~/.pi/agent/skills`, project `.pi/skills`) plus `<home>/skills`.
  `/skills` lists them, `/<skill-name> [task]` invokes one.
- **Cron**: Hermes `cron/jobs.yaml` format (`schedule`, `script`, `no_agent`, `prompt_file`, `deliver`,
  `origin`, `enabled`, `absent`). Timezone-aware. `NO_REPLY` stays silent.
- **Approvals**: off by default (no nannying). `/approvals manual [tool...]` or `/yolo` toggles; `/approve`, `/deny`.
- **Hermes slash commands** (gateway-relevant subset): `/new /reset /retry /title /compress /compact /stop
  /queue /steer /bg /btw /agents /goal /subgoal /heartbeat /loop /status /context /whoami /profile /sethome
  /model /reasoning /personality /busy /yolo /approvals /approve /deny /pause /restart /skills /reload-skills
  /reload-mcp /cron /help /commands /version`. Unknown `/words` go to the agent.

- **State**: heartbeats, loops, goals, reply addresses, `/busy`, `/sethome`, approvals, personality,
  `/pause` and `/cron pause` survive restarts (`<home>/state.json`, 0600). History is kept by the runtime.

## Matrix

Enabled when `MATRIX_HOMESERVER` and `MATRIX_ACCESS_TOKEN` (or `MATRIX_USER_ID` + `MATRIX_PASSWORD`) are set.
Same variables and defaults as the Hermes Matrix adapter, so AgentOS manifests carry over:

| Variable | Meaning (default) |
|---|---|
| `MATRIX_ALLOWED_USERS`, `MATRIX_ALLOW_ALL_USERS` | who may talk to the agent; invites from them are accepted |
| `MATRIX_ALLOWED_ROOMS` | group-room whitelist (DMs exempt) |
| `MATRIX_REQUIRE_MENTION` | groups need an @mention, `/command` or bot thread (`true`) |
| `MATRIX_FREE_RESPONSE_ROOMS` | no mention needed; unaddressed messages may be answered with silence |
| `MATRIX_OPTIONAL_REPLY_ROOMS` | coordination rooms: answering is always optional |
| `MATRIX_AUTO_THREAD`, `MATRIX_DM_AUTO_THREAD` | reply in a thread per mention (`true`) / in DMs (`false`) |
| `MATRIX_HOME_ROOM` | home for cron output and notices |
| `MATRIX_APPROVAL_APPROVERS` | only these MXIDs approve (✅/❌ reaction or `/approve`); also admins if `admins` is empty |
| `MATRIX_TEXT_BATCH_DELAY_SECONDS` | merge rapid messages of one sender (`0.6`) |
| `MATRIX_PROCESS_NOTICES`, `MATRIX_DISPLAY_NAME` | handle `m.notice` (`false`); name for plain-text mentions (agent name) |

Rooms with ≤2 members count as DMs. Every turn shows a typing indicator. Not yet: E2EE, media, edits
of own messages, reactions as acknowledgements.

**Delivery guarantees.** Inputs are saved (`<home>/state.json`) before the Matrix cursor
(`<home>/matrix-sync.json`) advances; replies go through a durable outbox with stable transaction ids.
With password login the access token is kept in `<home>/matrix-session.json` (0600), because Matrix
dedups retries per token. Transient errors retry forever. An event that keeps failing permanently is
parked after 5 attempts in `<home>/matrix-deadletter.jsonl`; a reply the homeserver permanently rejects
(4xx, e.g. no permission) goes to `<home>/outbox-deadletter.jsonl`. Both need a manual look. Limits: a turn
interrupted by a crash is replayed (at least once), and admins fall back to the approvers when Matrix
is on (otherwise only the console).

## Installation

See [installation instructions](docs/installation.md) for Linux, macOS, Windows-WSL,
Docker Compose and Kubernetes/GitOps. A Dockerfile and Compose example are included.
Run `vanillacore-harness` in any project directory to open the native PI TUI; no init
is required. Existing PI login/model settings are reused. `init` and `doctor` are optional
administrative helpers. `vanillacore-harness run` starts the separate gateway mode.
See [local self-development](docs/self-development.md) to use the harness as a coding agent
in its own user-owned checkout, or run it as a Linux user service.

## Run

```sh
npm install
VANILLACORE_HARNESS_HOME=~/.vanillacore-harness npm start      # console (stdin/stdout); with MATRIX_* also Matrix
                                             # (console then only on a TTY or with --console)
npm test && npm run typecheck
```

`<home>/harness.yaml`:

```yaml
agent: example-agent
model: example-provider/example-model     # configure provider/model in PI
thinking: high
timezone: Europe/Berlin
loop: { tickMs: 15000, busyMode: queue }
admins: ["@owner:example.org"]             # privileged command senders; see Matrix fallback above
```

Model credentials, providers and extensions come from PI's normal configuration (`~/.pi/agent`).
`/restart` exits with code 75 after draining; the supervisor restarts the process.

## Container

`./agent` is the PI config (`models.json` with providers, `settings.json`); `./home` holds
`harness.yaml`, `SOUL.md`, `VOICE.md`, state and sessions.

```sh
docker build -t vanillacore-harness .
docker run -p 8642:8642 -e API_SERVER_KEY=... -e GATEWAY_KEY=... \
  -v ./agent:/home/node/.pi/agent \
  -v ./home:/home/node/.vanillacore-harness \
  vanillacore-harness
```

Runs as uid 1000 under tini (SIGTERM drains in-flight turns for `loop.drainSeconds`).

Identity and provider configuration are supplied at runtime; state lives in the home volume.
See [operations](docs/operations.md) for memory pressure, crash recovery and console behavior,
and [configuration](docs/configuration.md) for provider credentials and memory-guard settings.

`GET /v1/models` lists `provider/model` refs plus each bare model id that is unique across
providers (Hermes-style alias); `POST /v1/runs` accepts either, and an optional `provider`
(`custom:` prefix ignored) must match the resolved one.

## Kubernetes

`deploy/kubernetes` is a standalone Kustomize example with a persistent home and a
non-root container. Supply your built image by immutable digest, create the referenced
Secret outside Git, and configure a provider in `models.json`. No credentials or tenant
configuration are included. Render with `kubectl kustomize deploy/kubernetes` and deploy
through your GitOps controller. The HTTP run API also supports AgentOS's `hermes_gateway`
adapter; AgentOS is optional.

## License

Apache License 2.0. See [LICENSE](LICENSE).
