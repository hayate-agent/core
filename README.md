# Hayate Agent

<img src="docs/assets/hayate-agent.jpg" alt="Hayate Agent" width="640">

**An AI agent for your terminal, browser and Matrix.** Work on code interactively, pick up
conversations later, or run Hayate as an always-on assistant for scheduled tasks
and longer projects.

Hayate manages conversations, task queues, scheduling and message delivery. It
uses [Pi](https://github.com/badlogic/pi-mono) as its current model and tool
runtime; no separate Pi installation is required.

## Get started

You need **Git and Node.js 22.19 or newer** with npm. Node 24 LTS is recommended.
Linux, macOS and Windows through WSL2 are supported.

```sh
git clone https://github.com/hayate-agent/core.git "$HOME/hayate-agent"
cd "$HOME/hayate-agent"
npm ci
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"

cd /path/to/your/project
hayate-agent
```

Keep the checkout: the local installation links to it. Add the PATH setting to
your shell profile if needed. In the terminal interface, use `/login` to connect
a model provider and `/model` to choose a model. Existing Pi provider settings in
`~/.pi/agent` can be reused; custom providers are configured in `models.json`.

Ask Hayate to inspect a project, explain code, make a change or run tests. Use
`/help` to explore commands and `/sessions` to return to an earlier conversation.

## What Hayate can do

- **Code in the terminal:** streaming responses, tool activity, session history
  and configurable tools in a fullscreen interface.
- **Work across conversations:** keep independent conversations and durable queues,
  with explicit session selection and resumption.
- **Run ongoing tasks:** heartbeats, cron jobs, recurring loops and standing goals.
- **Delegate work:** route tasks to model roles and validate sequential steps
  before moving on. Models and reasoning levels are configurable.
- **Use a browser:** the independently installed [WebUI](https://github.com/hayate-agent/webui)
  provides projects, conversations and connected-agent management through the
  agent's backend API.
- **Connect through Matrix:** DMs and rooms, encrypted conversations, user
  allowlists, mention rules and tool-approval handling.
- **Integrate with applications:** an HTTP run API with streamed progress,
  optional MCP tools and trusted plugins for commands, channels and policies.
- **Make it your own:** `SOUL.md` for identity, `VOICE.md` for tone and skills for
  reusable procedures.

## Choose your interface and starting configuration

The terminal works without an initialization step. For an explicit profile:

```sh
hayate-agent init --home "$HOME/.hayate-agent" --cwd /absolute/path/to/workspace
# After enabling the desired gateways:
hayate-agent run --home "$HOME/.hayate-agent"
```

`init` creates a commented starter configuration and identity files, without
replacing existing files or installing plugins. A
[copyable starter YAML](docs/examples/hayate-agent.yaml) is included in Core.

Follow the **[terminal, WebUI, Matrix and dispatcher setup guide](docs/gateways.md)**:

| Interface / feature | Activation |
| --- | --- |
| Terminal | Run `hayate-agent`; use `/login`, `/model` and `/help` |
| Standalone WebUI | Follow the [WebUI setup](https://github.com/hayate-agent/webui#readme); install its compatible backend separately |
| Browser dashboard | Separate WebUI project; Plugins supplies the API-only dashboard gateway. Core does not package the retired frontend |
| Matrix | Bundled plugin; inject `MATRIX_HOMESERVER`, bot credentials and sender/room policy |
| Dispatcher | Optional; verify backend concurrency, then enable `dispatcher` and restart |
| HTTP run API | Separately enabled with `API_SERVER_KEY` or a private loopback key file |

The packaged legacy WebUI remains local-only; do not expose that listener to a
network. The current [standalone WebUI](https://github.com/hayate-agent/webui#readme)
is a separate frontend with explicit TLS/backend configuration; install its
compatible authenticated backend from [Plugins](https://github.com/hayate-agent/plugins).
It does not replace Core's runtime, history or access-control policy. Matrix encryption requires persistent device
and crypto state. Supply credentials through your secret manager or environment,
never through a public configuration file. Use a supervisor for always-on use.

The default configuration does **not** start background dispatch, prescribe a
model/context size or grant remote operator rights. See the setup guide for
explicit admin/approver configuration and optional WebUI customization tools.

## Everyday commands

| Task | Commands |
| --- | --- |
| Start or resume a conversation | `/new`, `/title`, `/sessions`, `/resume` |
| Control current work | `/stop`, `/queue`, `/steer`, `/busy` |
| Schedule work | `/goal`, `/heartbeat`, `/loop`, `/cron` |
| Choose models and reasoning | `/model`, `/reasoning`, `/model-roles`, `/reload-models` |
| Manage context | `/compact`, `/skills` |
| Find help | `/help`, `/status` |

Command availability depends on the channel and your permissions. Use
`/reload-models` after changing provider/model configuration and `/reload-skills`
after changing skills. `/restart` fences new input, checkpoints work within one
configurable deadline (default60s), then restarts and resumes durable work.
Native installations check configurable Core/Plugins/WebUI Git sources hourly
and update automatically by default; `/update check`, `/update install` and
`/update status software` expose the same external lifecycle owner. Containers
keep image updates with their deployment owner. See [native lifecycle](docs/native-lifecycle.md).

## Configuration and safety

Agent state defaults to `~/.hayate-agent`. Set `HAYATE_AGENT_HOME` to use a separate
profile. An optional `hayate-agent.yaml` configures the agent, tools, scheduling
and model roles. Provider credentials live separately in `~/.pi/agent` or the
configured `PI_CODING_AGENT_DIR`. Back up both locations for persistent services.

Tool approvals are off by default; enable them for tools that require human
confirmation. Plugins run as trusted process code, not inside a sandbox. Queue
persistence does not make external side effects exactly-once: after an interrupted
operation, reconcile its actual result before repeating it.

Slack and Telegram adapters are not bundled with Core. Optional integrations are
installed separately from [Plugins](https://github.com/hayate-agent/plugins).
The [standalone WebUI](https://github.com/hayate-agent/webui) is likewise a separate
project, not a built-in Core web server.

## Documentation and related projects

- [Installation](docs/installation.md) — native CLI and background services
- [Gateway quickstart](docs/gateways.md) — terminal, WebUI, Matrix and dispatcher
- [Starter configuration](docs/examples/hayate-agent.yaml) — commented safe defaults
- [Configuration](docs/configuration.md) — providers, tools, identity and access
- [Sessions](docs/sessions.md) — history, resumption and storage
- [Model roles](docs/model-roles.md) · [Dispatcher](docs/dispatcher.md)
- [MCP](docs/mcp.md) · [Plugin API](docs/plugins.md)
- [Operations](docs/operations.md) — recovery, delivery and shutdown
- [hayate-agent/plugins](https://github.com/hayate-agent/plugins) — plugin adapters and backend services
- [hayate-agent/webui](https://github.com/hayate-agent/webui) — independent browser dashboard and presentation gateway
- [hayate-agent/deployments](https://github.com/hayate-agent/deployments) — deployment examples

## Contributing

Create a feature branch, add tests for your change and run:

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

Open a pull request with the problem, the change and its verification. See the
[development guide](docs/development.md) for architecture and testing details.

## License

[Apache-2.0](LICENSE).
