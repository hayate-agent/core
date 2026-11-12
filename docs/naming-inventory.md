# Hayate naming inventory — CLI/home vertical slice

This increment changes npm package/bin, CLI help, canonical home/config/env,
configuration initialization/diagnosis, both reasoning runtime consumers, container
executable/install path and primary native/Compose instructions. Fresh installs
use Hayate names. Explicitly selected state stays in place, never moved.
Internal repositories, registry images and agent identities are exempt.

## Remaining public export work (not a full-rename completion)

- API branding: `src/api/server.ts` health/platform and model `owned_by` still
  return the legacy product identifier. Rename with API assertions separately.
- PI extension labels: three `vanillacore-harness-*` labels in `src/runtime/pi.ts`.
- Matrix login device display name in the plugin-owned source
  `src/builtin-plugins/matrix-channel.ts` (materialized from the pinned plugins
  repository). Coordinate a focused plugins PR/pin; do not edit generated copies.
  Preserve existing device IDs/crypto state for running agents.
- Secondary docs still use old config/home/command examples: adaptive-skills,
  browser-tools, dispatcher, gateway-progress, local-maintenance-control, mcp,
  memory, operator-responsiveness, plugins, protected-content, review,
  self-development, session-attach, settings-dropins. Migrate examples, retaining
  operational local-upgrade prerequisites only, not public compatibility aliases.
- Kubernetes example: old configuration filename/home mounts and sample public
  resource/image names remain. Update as a separate coherent deploy example;
  actual internal image/repo/resource names are exempt, not blanket rename targets.
- Docker build args `HARNESS_VERSION`/`HARNESS_REVISION` remain coupled to current
  internal image CI. Inspect the actual producer before replacing the public
  build interface; do not silently break provenance metadata.
- Export audit must cover plugins/deployments and any selected historical evidence
  or ancillary files, not just Core runtime. Use the existing audited GitHub
  snapshot pipeline/PR, never a raw mirror or direct public push.

## Architecture is not legacy branding

`Harness`, `HarnessConfig`, `HarnessTuiChannel`, `harness.ts`, plugin APIs,
`harness-handover`, `harness-session-selection-v1`, runtime event/storage schemas
and `[harness]` diagnostic component labels describe the orchestration layer.
Do not mechanically rename them without evidence of a public product interface.
Third-party PI names/env and Matrix SDK package names are not Hayate branding.

## Operational boundary — merge/activation dependency

There are no public legacy home/config/env aliases or automatic discovery.
`--home` and `HAYATE_AGENT_HOME` can explicitly select any existing directory;
only `hayate-agent.yaml` is loaded there. No state move or activation is introduced.

Before merging or activating this slice, separately resolve the GitOps transition
for already-running authorized local agents: keep their current persistent home
and PVC, explicitly select that home with `HAYATE_AGENT_HOME`, and adapt the
configuration mount filename to `hayate-agent.yaml` without changing its content.
Translate any consumed old agent/reasoning environment names to their Hayate
names. Preserve sessions, memory, pending work, mounts and identities. Removing
fallbacks does not activate or transition an agent. New Compose paths are canonical;
no live Compose/pod is changed. Internal image/repository names remain exempt.
