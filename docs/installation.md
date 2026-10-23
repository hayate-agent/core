# Installation

Supported targets: Linux, macOS and Windows through WSL2 (a Linux distribution).
Native Windows outside WSL is not a supported deployment target. Use Node.js 22+
with npm, Git and a configured model provider. No root execution is required.

## Native installation

Use a user-owned checkout and npm prefix; do not use sudo npm.

```sh
git clone https://git.vanillacore.net/harness/core.git vanillacore-harness
cd vanillacore-harness
npm ci
npm run typecheck
npm test
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
vanillacore-harness version
```

Persist that PATH entry in your shell profile if needed. The local global install
links this checkout: keep it at its installed location. `npm ci` builds the CLI via
`prepare`. After pulling updates, run `npm ci` and restart the process.

```sh
mkdir -p "$HOME/.vanillacore-harness" "$HOME/.pi/agent"
cp deploy/kubernetes/harness.yaml "$HOME/.vanillacore-harness/harness.yaml"
cp deploy/kubernetes/SOUL.md "$HOME/.vanillacore-harness/SOUL.md"
cp deploy/kubernetes/models.json "$HOME/.pi/agent/models.json"
```

Edit these examples: choose your identity, provider endpoint and actual model ID.
Supply `MODEL_API_KEY` securely in the process environment (the example provider
references it). Do not commit credentials. Then start interactively:

```sh
vanillacore-harness run
```

For a headless API service, set `API_SERVER_KEY` as well. Matrix is enabled through
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
cp deploy/kubernetes/{harness.yaml,SOUL.md,models.json} config/
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

Render `kubectl kustomize deploy/kubernetes`. Replace the placeholder image with a
published immutable digest and supply `harness-credentials` out-of-band. Configure
identity, models and any channel credentials in your private overlay repository.
The example does not create an Ingress or restrict egress; supply NetworkPolicies
appropriate to your environment. Configuration mounted with subPath requires a pod
restart after changes. Provision a persistent volume usable by uid/gid 1000.

## Verification scope

The TypeScript suite is runtime-independent where possible. Native CLI installation
is smoke-tested on the development host; Linux container builds exercise the Linux
packaging path. WSL and other macOS/Linux machines still require platform smoke tests.
