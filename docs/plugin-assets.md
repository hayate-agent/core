# Packaged optional plugin assets

Core's npm package and image ship the optional WebUI under
`dist/optional-plugins/webui/`. It remains a separate plugin: packaging neither
activates a listener nor changes command authority. Its source lives exclusively
in `harness/plugins`, not in Core runtime code.

`plugin-assets.lock.json` pins the source repository, immutable commit and SHA-256
for every required source/build file. `npm run build` materializes and verifies
all source bytes before replacing generated input, installs exact npm-lockfile
build dependencies with lifecycle scripts disabled, and invokes locked esbuild
to produce the browser bundle. Gateway factories and UI modules never execute
during this process. The copied runtime artifact contains only the ESM entry,
UI settings/module implementation, built browser files, README and provenance;
it does not ship a second node_modules tree.

Normal dependency installation/build requires network access to pinned Forgejo
sources and lockfile-resolved npm tarballs. There is no startup download, npm
install, marketplace, writable server-side source copy or auto-activation.
For offline source development, `node scripts/materialize-plugin-assets.mjs
/path/to/plugins-checkout` verifies identical hashes against the local checkout,
then `node scripts/build-plugin-assets.mjs` uses the locked dependencies.

## Activation

For the runtime image, select the installed entry in a typed settings layer:

```yaml
gatewayPlugins:
  webui:
    module: /opt/hayate-agent/dist/optional-plugins/webui/index.mjs
```

This can be an operator-managed `settings.d/95-webui.yaml` without replacing the
agent's writable `settings.local.yaml` or other gateway overrides. Optional UI
customization requires the same path under `plugins` in installation config;
add `plugin_webui_settings` if tools are explicitly allowlisted. Do not replace
other configured plugins/tools/admins. A normal Core package locates these files
under its own `dist/optional-plugins`, while native extracted releases use their
verified `current/dist/optional-plugins` path. No model settings are prescribed.

The listener remains `127.0.0.1:3210`; no Service/Ingress is required or authorized.
In a pod it is pod-local, not remotely browsable. Existing Matrix/API behavior and
its security policy remain unchanged. Preserve state/crypto on upgrades, use
normal host admission and graceful drain, and verify provenance, loaded channel,
local HTTP assets and idle/busy admission after rollout.

For full local setup and the separate network-authentication design, see
[gateways.md](gateways.md) and the upstream WebUI plugin guide. An image containing
the plugin proves availability, not per-agent activation or network authentication.
