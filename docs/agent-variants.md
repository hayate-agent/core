# Persistent agent-owned product variants

An agent-specific Core, Plugins or WebUI change need not become a shared-product
upstream contribution. Keep configuration/skills/extensions at the smallest
existing boundary first; product-code variants belong in an assigned private
agent/configuration repository, not in edited installed/generated files.

## Recipe and native owner

`softwareUpdates.variant` selects a reviewed recipe in the existing assigned repo:

```yaml
softwareUpdates:
  sources:
    core: {repository: 'https://example.org/product/core.git', branch: main}
    plugins: {repository: 'https://example.org/product/plugins.git', branch: main}
    webui: {repository: 'https://example.org/product/webui.git', branch: main}
  variant:
    repository: https://example.org/agents/my-agent.git
    branch: main
    manifest: variants/my-agent/recipe.json
    review:
      runner: /opt/agent-owner/verify-variant-review
      sha256: '<SHA256 of the separately installed trusted executable>'
```

The strict JSON recipe is `schema:1`, a lowercase `profile`, `bases` with all three
component repository URLs and full40-character immutable commit SHAs, and ordered
`patches`: `{component:"core"|"plugins"|"webui", path:"patches/name.patch",
sha256:"<64hex>"}`. Paths stay inside the recipe checkout; duplicate paths,
symlinks, credential-bearing URLs, wrong hashes, oversized patches and mutable
base refs are refused. Native base repositories must match configured sources.
Each patch is applied with `git apply --check --index`, then `git apply --index`,
only in a fresh disposable checkout. No three-way/fuzz fallback or runtime edits.

The review binding covers profile/repository/manifest, raw recipe digest, fixed
bases and ordered patch hashes. Repository commit identity is separately recorded.
Unrelated config commits do not invalidate unchanged reviewed recipe content or
cause endless reinstallation. Any recipe/base/patch change changes the binding.

A new base HEAD is an update **candidate**, never silently substituted under a
reviewed patch set. The owner exposes `variantBaseCandidates` and retains the
installed variant until a new recipe has been composed, tested and independently
reviewed. No completed tasks, pauses, credentials or budgets are reset. Candidate
regressions run before selection; existing startup qualification and orderly
foreground-owner checkpoint/exit remain authoritative.

Bundled plugin patches deliberately generate a local hash lock with recorded
upstream-base-lock digest and private binding. The changed bytes are not claimed
to equal upstream source. Plugin base must agree with Core's original lock.

Payload/source hashes and review receipts survive owner restart. Booting an
already-selected approved last-good release does not require the review network.
A fresh activation revalidates review and payload; denial/tampering retains the
last-good selector. Removing the variant field accidentally or replacing the
bootstrap silently is refused. An explicit operator-owned `variant:null` permits
an intentional return to the configured common source path; it is not an agent
permission to edit installation policy. Recovery never deletes locks or kills old
work to obtain admission.

## External review, not self-attestation

The verifier executable is installed independently of candidate sources, with an
exact SHA256 pin. It receives `{schema:1,identity,recipe}` on stdin and must return
only `{binding,reviewer,evidence,independent:true}` after authenticating evidence
from the existing independent review process. A model-written receipt in the
candidate repository is not accepted as verification. The reviewer must be
independent of the logical author, not just another self-chosen login/string.
Verifier failure, stale review or changed bytes are blockers.

The overlays owner supplies an adapter for authenticated Forgejo review inventory,
including exact approved head, author/reviewer separation, approved recipe/patch
content equality, rejection/dismissal and origin-bound reader credentials. Other
existing external review systems can supply the same trusted executable contract.
**No required-approvals setting is changed; 0 mandatory Forgejo approvals remains
valid.** The trusted adapter, its dependencies and policy must be independently
reviewed and protected by the installation owner. A wrapper hash alone must not
be used to bless mutable candidate-provided dependencies. This is a trusted-code
boundary, not a sandbox against an agent with the same OS write privileges as its
owner. Never install an admin/personal fallback token into a runtime.

## Container and frontend owners

`node dist/compose-agent-variant.js <trusted-policy.json> <fresh-output-dir>`
resolves and independently verifies the recipe, checks out exact component bases,
applies patches and produces source contexts plus a bound receipt. It never
pushes sources, publishes an image, merges a PR or changes a running agent.
`core/Dockerfile.variant` and `webui/Dockerfile.variant` run their respective tests
and builds as nonroot without review/publisher credentials. Core uses explicit
hash-locked plugin inputs, not a failed upstream fetch of private patch bytes.
Generated metadata/OCI binding distinguish a private artifact from a shared build.
Build and publish through the existing deployment owner's custody, then use its
normal separate integration and live verification path. A prepared context or
pushed artifact is not activation. Images must remain within the assigned private
artifact custody; do not expose private modifications through public packages.

The common promotion adapter recognizes explicitly registered `agents.json`
`variants` owners and refuses to replace their artifacts with the shared digest.
This is a loss guard, **not** an automatically commissioned variant publisher.
Per-profile artifact publication/consumer wiring must be assigned before enabling
a container variant. Missing bindings are explicit blockers, not a reason to use
ad-hoc live patches or suppress shared updates globally.

A WebUI package checkout/build does not prove the actual frontend is using it.
The generic native Core owner therefore refuses WebUI patches pending an explicit
frontend owner; the composer can produce its separate build context. Do not claim
that Core installation activates an unrelated frontend. Parked/unconfigured WebUI
consumers remain parked; no new listener, ingress, port or credential is inferred.

## Rollout and updates

Source preparation and isolated tests can precede approval; merge/live activation
of product source changes require independent external review. Private variants
are not an exemption. Upstream contribution remains an explicit separate choice.
A complete enrolled profile binds repository/recipe, reviewer policy, base commits,
resulting immutable image/native artifact, consumer and last-known-good state.
On conflict or missing evidence, block only that profile and preserve all work.
The framework and owner adapters must themselves pass independent review before
production installation; example recipes or unit fixtures are not live approvals.
