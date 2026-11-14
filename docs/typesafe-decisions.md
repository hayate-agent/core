# TypeSafe decision integration (declared contract; not live acceptance)

Architecture:

- Plugins `typesafe-api-plugin.ts`: shared `typesafe-api` service v1, bounded
  SystemOne choice transport, no runtime/cloud/legacy fallback.
- Plugins `typesafe-decision-plugin.ts`: separate `typesafe-completion` and
  `typesafe-dispatch` advisory adapters, re-exporting application-owned frozen v1
  banks from `typesafe-question-banks.ts`. The shared transport accepts only these
  three registered versions and their exact policy, canonicalized before awaits.
  Unknown bank IDs/versions, altered policy and bank-size violations fail closed
  before credential reads or wire I/O (2..8 choices, <=2000 instruction bytes,
  <=500 UTF-8 bytes per criterion).
- Core: additive `registerDispatchDecisionProvider` and independent
  `PluginHost.dispatchDecisions` registry (reuses the existing `ValidatorProvider`
  request/result interface); optional `requiresModel:false` skips unrelated LLM
  model qualification. The existing sequential consumer retains authority,
  parent-stop/deadline/decision fences, retry/backoff, readiness candidate checks,
  no-progress and unknown-effects reconciliation. It never replays a worker just
  because the API failed. Runtime-based planning and ordinary work are unchanged.
- CLI registers both adapters and the shared transport when `typeSafeDecisions`
  is supplied, selects each consumer independently, then resolves both registries
  only AFTER builtin and operator plugin activation. Services resolve lazily;
  activation order does not matter. Selection alone cannot silently load a
  transport or fall back to another provider.

`dispatcher.decisionProvider` omission preserves legacy configurations only when
completion's selected provider is `legacy-llm`; otherwise the Dispatcher decision
provider is disabled until explicitly selected, never implicitly cloud-backed.
Direct Dispatcher strategy does not perform step assessments; configure sequential
for the step/readiness decision path. Custom strategies retain their own policy.

## Ready configuration patch (not applied)

The same fragment is available in `examples/typesafe-decisions.patch.yaml`.
Merge it into the operator-owned agent configuration only after the later
publication/activation gates, preserving existing authorizations, dispatcher
concurrency consent, roles and other settings:

```yaml
typeSafeDecisions:
  endpoint: https://gateway.example.invalid/v1/systemone
  model: openjev-latest
  bearerTokenFile: /run/secrets/typesafe-bearer-token
  timeoutMs: 5000
completionCheck:
  provider: typesafe-completion
dispatcher:
  decisionProvider: typesafe-dispatch
```

No new completion authorization, enabled Dispatcher, concurrency consent, or model
role is granted by this fragment. Current grants and budgets still govern. For
both consumers, retain the existing sequential strategy and explicit model roles
if already enabled. A restart is needed for this bootstrap binding/selection.

The reference must resolve to a non-symlink final component, regular file owned by
the native process user, mode 0600 (or stricter), at most 4096 bytes, containing a
plain bearer token with optional final newline. Parent directory symlinks are
supported. No environment scan, inline token, token interpolation, URL credentials,
query strings, endpoint discovery, redirects or non-loopback plaintext HTTP.
The designated credential's format/mode has NOT been inspected by this worker;
confirm compatibility read-only before applying anything. Never print its value.
Credentials are resolved per assessment to support rotation. Registration reads
no credentials and performs no network I/O.

The transport has a <=10s timeout, 24KB UTF-8 state budget, 16KB streamed response
budget, 2..8 choices per bank, and no retry. Host retries remain separately owned.
Exports use only the existing host-rendered assessment prompt, not entire request,
backend, environment or authorization object. Oversized evidence is rejected, not
silently truncated to force a verdict. Recognizable credential assignments/private
keys are rejected before export; the bound bearer token is also checked against
state before sending. This is not a guarantee of general-purpose secret detection
in arbitrary prose. Existing host evidence sanitization remains necessary.

## Contract and uncertainty

Declared request: `{model, state, samples:1, questions:{[bank.id]:{type:"choice",
instructions, criteria}}}`. The retained completed contract receipt pins Envoy
AI Gateway v1.2.0 at `daa9f891a8afcb18576d4593ad18870d1d18abac`,
`internal/apischema/typesafe/systemone.go:11-54`: model/state/questions and
choice/noul/score answers with optional usage. `samples` is not mandatory in that
schema; the additional `samples:1` matches the existing OpenJEV native consumer.
The narrower choice/confidence/probabilities dialect intentionally rejects
score-only and noul answers rather than inferring authorization. This can reject
otherwise valid server responses, but cannot turn uncertainty into authorization.
Accepted response:
`{model, answers:{[bank.id]:{type:"choice", choice, confidence, probabilities}},
usage?:{input_tokens?,output_tokens?}}`. Model and bank must match, no foreign
keys/authority fields, all probabilities present/finite/in [0,1] and sum to 1,
confidence >=.9. Confidence and probability values are NOT required to be equal.
`noul` may be valid upstream, but is not a choice/confidence and cannot authorize
these consumers. Unknown/invalid/low-confidence/failure returns no verdict.
Completed/waiting/blocked/more map to fixed semantic results, never provider-written
host directives. Ready-step answers are bounded numbers, then the host validates
membership in its independently ready candidate list and rechecks authority.

Route evidence: fleet `rack/kubernetes/applications/ai-gateway/typesafe/openjev.yaml`
uses model `openjev-latest` with TypeSafe/v1 backend. Prior GET /v1/models exposed
that model. GET /v1/systemone 404 is NOT a POST absence proof. The completed
upstream contract receipt confirms `/v1/systemone` registration, body-model route
selection and body preservation without a client routing header. No new discovery
was performed here. Configured-model live behavior still requires separately
released verification; these source-backed fixtures are NOT live API acceptance. Earlier unauthorized/unreconciled Gateway
POST receipts remain preserved; this implementation neither repeats nor endorses
them. No live activation, configuration, credentials or releases were changed.

## Offline development evidence

From an isolated Core checkout with existing dependencies:

```sh
# Host library override is incompatible with /usr/bin/node; do not change the daemon.
unset LD_LIBRARY_PATH
umask 022
HAYATE_TEST_CONCURRENCY=4 node scripts/test-local-typesafe.mjs /absolute/plugin/source --full
```

This uses the supported explicit local materializer lock, typechecks, builds,
runs plugin transport units and the full Core unit/integration suite (including
real Harness completion and sequential Dispatcher consumers -> registered adapters
-> real loopback HTTP mock). Built-JavaScript exports and registration order are
also tested. Fault injection at the registered service boundary proves both real
consumers reach transport rejection for unknown bank IDs/versions and over-limit
banks; the listening loopback mock receives zero requests for these invalid banks.
Positive, negative and provider-error response cases do traverse the HTTP wire.
The mock is Node HTTP, NOT the Java WireMock product. No WireMock
runtime/JAR/image is locally available and none is downloaded under the parent's
no-external-network boundary. Do not misreport this as a Java WireMock run.

The checked-in production plugin lock is intentionally untouched in this local
implementation slice. After protected plugin publication, materialize its exact
merged revision into Core and run normal protected CI at the final exact heads.
Before that lock update, plain production build cannot include the new modules.
Neither local test success nor a development lock proves deployability. Required
reviews/CI/publication/final immutable lock and later parent-only native activation
and separately released live acceptance remain outstanding.
