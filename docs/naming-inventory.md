# Hayate naming inventory — CLI/home vertical slice

This increment changes npm package/bin, CLI help, canonical home/config/env,
configuration initialization/diagnosis, both reasoning runtime consumers, container
executable/install path and primary native/Compose instructions. Fresh installs
use Hayate names. Existing local agent state is read in place, never moved.
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
  explicit local-upgrade explanation only.
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

## Compatibility boundary

Only old local home/config/env inputs remain accepted by this slice. No old npm
package/bin alias, migration framework, directory move, agent replacement or
activation is introduced. A legacy home remains authoritative unless explicitly
selected otherwise; ambiguous dual default homes fail closed. Container home env
is deliberately not forced, allowing the same local-home resolver for mounted
existing agents. New Compose paths are canonical; no live Compose/pod is changed.
