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
nonce- and request-bound foreground metadata at the supported final HTTP fetch
boundary, after SDK serialization and payload extensions. V2 includes the actual
method, exact path, original model and canonical full JSON body identity; it
never substitutes a guessed transcript for actual wire data. This is **not a provider credential** and cannot
authorize a task or effect. No key is created by this source change. It must be
provisioned through the owning lifecycle with private, owned regular-file mode
0600; symlinks, nonregular, oversized or incorrectly protected files are refused.
Only public verification keys belong at the shared admission service. Unsigned,
unknown-key or replayed claims must be treated as background by that service.
Existing provider credentials and the explicit local-model list remain unchanged.
Only the existing `/v1/chat/completions`, `/v1/completions` and `/v1/responses`
POST endpoints are supported for signed scheduling. Custom prefixes, query
strings and unknown streaming Request bodies stay unsigned/background; this is
not a universal custom-provider optimization. The local OpenAI adapters retain
existing custom fetch/auth/body/signal behavior. A fresh proof is generated on
each actual HTTP retry, never reused as permission to replay business effects.

Native summary calls have a separate SDK request session ID, so they cannot
inherit foreground even inside an active human turn. No sticky tree/compaction
maintenance flag is needed; cancellation/failure cannot leave one behind. SDK
one-token cache-warming calls are conservatively background as well.

## Provisioning and rotation lifecycle

The runtime loads this optional key once at construction. Missing/invalid keys
mean no proof, not a cloud fallback or new authority. Provisioning, resealing or
rotation therefore requires a **normal graceful owning runtime restart** before
the new key is used. Do not expect editing the file to hot-reload the cached key.
Enroll a new public key before switching its signer, keep the old verifier while
old requests can still arrive, then retire it after those requests/proofs drain.
Never restart active business writers forcibly to rotate a scheduling key.

## Optional in-runtime admission (not global hardware QoS)

Installations can explicitly configure physical local request concurrency:

```yaml
localModelScheduling:
  - model: homelab-main/deepseek-v4-flash
    concurrency: 1
```

Omitted means unchanged/unrestricted behavior. This is an installation setting,
not a model-writable settings overlay or a token/context-window limit. Only the
specified physical endpoint + model is affected. Provider aliases pointing at
that same endpoint/model share capacity, including Main, worker, subagent, native
summary, HTTP classifier/planner/review, and review-worktree requests in this
runtime. Different physical models are unaffected; model, thinking, original
worker intent, tools, effect ownership and completion/review authority are not
changed.

The permit covers one **complete model response**, not just headers/first delta
and not the subsequent tool batch or its independent assessment. Queued human
requests precede queued background work; after four foreground admissions a
waiting background request gets its turn. Already-running inference is never
aborted or migrated. Waiting precedes creation of the SDK provider stream/HTTP
timeout, so waiting cannot itself trigger repeated HTTP attempts. Cancellation
and authority/expiry are rechecked before sending; cancelled queued work sends
nothing. Explicit outer task/review deadlines remain binding. A local queue event
is reported as capacity waiting/admission/cancellation, not as model reasoning,
tool progress, a productive receipt or a reset of own semantic inactivity.

This prevents one runtime from filling the same backend with competing cold
prefills and retry queues. It does **not** control other processes/agents, reserve
hardware globally, preempt a long already-running request, or bound provider
queue/prefill duration. The separate signed headers remain metadata until an
actual shared admission owner uses them. Activate configuration through the
normal runtime owner; never silently restart other active model users.

## Delivery boundary

The actual SDK/HTTP fixture verifies foreground/background headers, signatures,
credential preservation, real native compaction, real compaction cancellation and
turn cleanup, ephemeral requests, and a nonlocal model switch. It makes no live
model requests and is not an inference-speed measurement.

Shared admission, complete legacy-ingress fencing, owner-managed key enrollment,
protected exact-head CI/merge, installed runtime bytes and comparable live latency
acceptance are separate delivery steps. This source alone does not create a
shared model queue or prove a faster Minerva/Che response.
