# Hayate Agent

<img src="docs/assets/hayate-agent.jpg" alt="Hayate Agent" width="640">

**An AI agent for your terminal and Matrix.** Work on code interactively, pick up
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
- **Connect through Matrix:** DMs and rooms, encrypted conversations, user
  allowlists, mention rules and tool-approval handling.
- **Integrate with applications:** an HTTP run API with streamed progress,
  optional MCP tools and trusted plugins for commands, channels and policies.
- **Make it your own:** `SOUL.md` for identity, `VOICE.md` for tone and skills for
  reusable procedures.

## Run a Matrix or API assistant

```sh
hayate-agent run
```

Configure `MATRIX_HOMESERVER` and the agent's access token or password-login
settings before starting Matrix. Set allowed users and room policies before
inviting the agent to shared rooms. Encrypted conversations need persistent
Matrix device and crypto state.

The HTTP API is enabled with `API_SERVER_KEY`. Supply credentials through your
secret manager or runtime environment, never through a public configuration file.
Use a service supervisor or container for an always-on assistant.

See [installation](docs/installation.md), [configuration](docs/configuration.md)
and [Matrix encryption](docs/matrix-e2ee.md) for setup details.

## Everyday commands

| Task | Commands |
| --- | --- |
| Start or resume a conversation | `/new`, `/title`, `/sessions`, `/resume` |
| Control current work | `/stop`, `/queue`, `/steer`, `/busy` |
| Schedule work | `/goal`, `/heartbeat`, `/loop`, `/cron` |
| Choose models and reasoning | `/model`, `/reasoning`, `/model-roles` |
| Manage context | `/compact`, `/skills` |
| Find help | `/help`, `/status` |

Command availability depends on the channel and your permissions.

## Configuration and safety

Agent state defaults to `~/.hayate-agent`. Set `HAYATE_AGENT_HOME` to use a separate
profile. An optional `hayate-agent.yaml` configures the agent, tools, scheduling
and model roles. Provider credentials live separately in `~/.pi/agent` or the
configured `PI_CODING_AGENT_DIR`. Back up both locations for persistent services.

Tool approvals are off by default; enable them for tools that require human
confirmation. Plugins run as trusted process code, not inside a sandbox. Queue
persistence does not make external side effects exactly-once: after an interrupted
operation, reconcile its actual result before repeating it.

Slack and Telegram adapters and a web chat interface are not included. Matrix
and the terminal are the supported interactive interfaces.

## Documentation and related projects

- [Installation](docs/installation.md) — native CLI and background services
- [Configuration](docs/configuration.md) — providers, tools, identity and access
- [Sessions](docs/sessions.md) — history, resumption and storage
- [Model roles](docs/model-roles.md) · [Dispatcher](docs/dispatcher.md)
- [MCP](docs/mcp.md) · [Plugin API](docs/plugins.md)
- [Operations](docs/operations.md) — recovery, delivery and shutdown
- [hayate-agent/plugins](https://github.com/hayate-agent/plugins) — plugin adapters
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
