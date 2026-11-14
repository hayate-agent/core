# Local model scheduling metadata (source support, not admission activation)

Configured local models may receive `X-Hayate-Model-Work` with `interactive` or
`background`. Human-facing Main turns default interactive. Delegated, cron,
ephemeral and maintenance/summarization requests cannot inherit their surrounding
human turn's interactive classification. Outside an active prompt, requests are
background. Unknown machine/API turns default background.

Authenticated API run submission optionally accepts `model_work: "interactive"`
or `"background"`. This is turn-scoped scheduling metadata included in request
idempotency. It does not change model selection, tool access, task/execution
identity, permissions, task priority/authority, deadlines, budgets or replay
consent. Cron/delegated/maintenance work cannot override its background class.

An optional, separate Ed25519 key at `<home>/model-work-key.pem` signs short-lived,
nonce-bound foreground metadata. This is **not a provider credential** and cannot
authorize a task or effect. No key is created by this source change. It must be
provisioned through the owning lifecycle with private, owned regular-file mode
0600; symlinks, nonregular, oversized or incorrectly protected files are refused.
Only public verification keys belong at the shared admission service. Unsigned,
unknown-key or replayed claims must be treated as background by that service.
Existing provider credentials and the explicit local-model list remain unchanged.

## Provisioning and rotation lifecycle

The runtime loads this optional key once at construction. Missing/invalid keys
mean no proof, not a cloud fallback or new authority. Provisioning, resealing or
rotation therefore requires a **normal graceful owning runtime restart** before
the new key is used. Do not expect editing the file to hot-reload the cached key.
Enroll a new public key before switching its signer, keep the old verifier while
old requests can still arrive, then retire it after those requests/proofs drain.
Never restart active business writers forcibly to rotate a scheduling key.

## Delivery boundary

The actual SDK/HTTP fixture verifies foreground/background headers, signatures,
credential preservation, real native compaction, real compaction cancellation and
turn cleanup, ephemeral requests, and a nonlocal model switch. It makes no live
model requests and is not an inference-speed measurement.

Shared admission, complete legacy-ingress fencing, owner-managed key enrollment,
protected exact-head CI/merge, installed runtime bytes and comparable live latency
acceptance are separate delivery steps. This source alone does not create a
shared model queue or prove a faster Minerva/Che response.
