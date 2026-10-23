# Local use and developing the harness with itself

This is an additive installation: it does not remove or stop Hermes or PI. The
harness embeds PI as its model/tool runtime; it is not yet a full replacement for
PI's interactive TUI. Its console is line-based. Matrix and the API provide the
persistent gateway path. Slack, managed MCP/CLI installation and automatic runtime
promotion/rollback remain unimplemented.

## Start as a local coding agent

Install from a user-owned checkout as described in installation.md, then:

```sh
vanillacore-harness init --agent builder --cwd "$HOME/projects" --model provider/model
vanillacore-harness doctor
vanillacore-harness run
```

Replace the workspace and model with real values. Configure provider credentials
in PI's user configuration or the provider's supported environment variables.
Existing PI provider/extension configuration is reused from the same agent directory;
initialization never copies or overwrites credentials. To isolate it instead, set
`PI_CODING_AGENT_DIR` to another user-owned directory and configure that directory.
SOUL, voice, tools and model can be changed in the generated configuration; restart
to apply changes to existing sessions.

## Use the harness to build itself

Use a feature branch and the checkout as the configured working directory:

```sh
cd "$HOME/projects/vanillacore-harness"
git switch -c feat/my-change
vanillacore-harness init --home "$HOME/.vanillacore-harness-dev" \
  --agent builder --cwd "$PWD" --model provider/model
vanillacore-harness run --home "$HOME/.vanillacore-harness-dev"
```

Example task to give the running agent:

> Implement the requested change in this checkout. Inspect existing code first.
> Run npm run typecheck, npm test and npm run build. Show the diff and any failed
> checks. Do not push to main, change branch protections or overwrite credentials.

The selected read/bash/edit/write tools permit actual source edits and builds as
your user. No root or immutable-image modification is needed. This is development
capability, not isolation: tools have the permissions of your OS account.

The running Node process does not hot-replace imported code. After a successful
build, use a second terminal to smoke-test `node dist/cli.js version` and
`node dist/cli.js doctor --home "$HOME/.vanillacore-harness-dev"`. Finish or stop
the current session, then restart the installed CLI to activate the new build.
The global local-directory installation points to this checkout. Avoid replacing
node_modules during an active turn; finish it before dependency updates.

Use normal commits/PRs for durable changes. Keep the old tested commit available;
to test a fallback, create a separate worktree and build it rather than resetting
the active checkout. Fully automated version promotion and rollback are future work.

## Linux user service

For an API/Matrix daemon, a systemd user unit can run the installed CLI. Do not use
this unit for an interactive stdin conversation. Example (replace absolute paths):

```ini
[Unit]
Description=VanillaCore Agent Harness

[Service]
Type=simple
WorkingDirectory=/home/USER/projects
EnvironmentFile=/home/USER/.config/vanillacore-harness/service.env
ExecStart=/home/USER/.local/bin/vanillacore-harness run
Restart=on-failure
RestartSec=5
TimeoutStopSec=90

[Install]
WantedBy=default.target
```

Supply API_SERVER_KEY or MATRIX_* settings and provider configuration securely in
the service environment; chmod the environment file 600 and do not commit it.
The service needs a PATH containing Node and any tool executables. Install the unit
under ~/.config/systemd/user/, run systemctl --user daemon-reload, then enable/start
it. Linger is a separate administrator decision if it must run while logged out.
