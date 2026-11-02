# Installation

Supported targets: Linux, macOS and Windows through WSL2 (a Linux distribution).
Native Windows outside WSL is not a supported deployment target. Use Node.js 22+
with npm, Git and a configured model provider. Minimum Node version is 22.19.0;
Node 24.22.1 LTS is recommended and recorded in `.node-version`. No root execution is required.

## Native installation

Use a user-owned checkout and npm prefix; do not use sudo npm. The canonical
source is [hayate-agent/core](https://github.com/hayate-agent/core). Publication
there is still pending (the repository is currently empty); the clone command
below requires published source on `main`. Until then, use an existing verified
checkout.

```sh
git clone https://github.com/hayate-agent/core.git "$HOME/hayate-agent"
cd "$HOME/hayate-agent"
npm ci
npm run typecheck
npm test
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
hayate-agent version
```

Persist that PATH entry in your shell profile if needed. The local global install
links this checkout: keep it at its installed location. `npm ci` builds the CLI via
`prepare`. After pulling updates, run `npm ci` and restart the process.

### Start in any project

```sh
cd /path/to/your/project
hayate-agent
```

This opens the Hayate Agent TUI (using PI terminal components) in the current directory.
Each launch starts a fresh, workspace-scoped conversation. Use `/sessions` and
`/resume` to explicitly select an earlier conversation, or `/new [title]` to start
another. The active session is shown in the header; resumed history is displayed.
See [session management](sessions.md) for storage, locking and migration details. No `init`, `doctor`, model
placeholder or copied example configuration is required. Existing PI login,
provider, settings and extension configuration is reused from `~/.pi/agent`, or
from `PI_CODING_AGENT_DIR` when set. Use the TUI's `/login` and `/model` controls
as needed. Do not overwrite an existing `models.json` with the deployment example.
Changes to shared PI settings can also affect your regular PI installation.
Neither Hermes nor PI is uninstalled or stopped.

You can also test without installing the command globally: after `npm ci`, run
`node "$HOME/hayate-agent/dist/cli.js"` from your project directory.

Optional `init` creates missing Hayate Agent persona/configuration files without
replacing existing files; `doctor` checks local configuration, not provider
connectivity. Neither is a prerequisite for interactive use. See
[configuration](configuration.md) for a separate agent profile and
[self-development](self-development.md) for using the agent on its own source.

### Gateway / background service

`hayate-agent run` starts the same persistent Hayate Agent without its TUI.
Interactive mode runs the Hayate Agent scheduler and configured gateway channels too. For a headless API service, set `API_SERVER_KEY`. Matrix is enabled through
`MATRIX_*` variables (see the main README). Slack is not implemented yet.
For an always-on native service use your OS supervisor (systemd on Linux/WSL with
systemd enabled, launchd on macOS), preserving HOME, PATH and your secret injection.
A `/restart` exits with status 75; configure the supervisor to restart on failure.
No native service installer is included yet.

## Docker Compose

Requires Docker Engine with Compose v2 on Linux/WSL, or Docker Desktop on macOS/Windows.
From the checkout:

```sh
mkdir -p config
(set -C; cat deploy/kubernetes/hayate-agent.yaml > config/hayate-agent.yaml) || exit 1
for file in SOUL.md models.json; do
  # Exclusive creation: stop rather than overwrite an existing configuration.
  (set -C; cat "deploy/kubernetes/$file" > "config/$file") || exit 1
done
```

Edit those files before starting. Set `API_SERVER_KEY` and `MODEL_API_KEY` in the
calling shell using your secret manager, then:

```sh
docker compose up --build -d
docker compose logs -f harness
docker compose down
```

The API binds only to localhost. A named volume retains sessions and PI state;
`docker compose down -v` deletes it. Config files are mounted read-only, so edits
are operator-owned in this example. This does not implement self-modifying runtime
activation. Do not expose the API publicly without your own ingress policy.
Add `MATRIX_*` environment entries to a private Compose override if desired.

## Kubernetes / GitOps

The canonical deployment repository is
[hayate-agent/deployments](https://github.com/hayate-agent/deployments). It is
currently empty; no directory layout or migration from older overlay/base
repositories is established here. The instructions below use Core's checked-in
example, not an assumed path in that repository.

Render `kubectl kustomize deploy/kubernetes`. Replace the placeholder image with a
published immutable digest and supply `harness-credentials` out-of-band. Configure
identity, models and any channel credentials in your private overlay repository.
The example does not create an Ingress or restrict egress; supply NetworkPolicies
appropriate to your environment. Configuration mounted with subPath requires a pod
restart after changes. Provision a persistent volume usable by uid/gid 1000.

## Verification scope

The TypeScript suite is runtime-independent where possible. Verified on macOS and
Linux (WSL2): dependency installation, typecheck, all 176 tests and native CLI builds.
The previous PI-wrapper TUI was started in a pseudoterminal on macOS and Linux (WSL2),
and `/quit` exited successfully. The Linux container build and CLI version were
also verified with Node 24.22.1. These tests do not replace live model/provider
or channel integration tests.
