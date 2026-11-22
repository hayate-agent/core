# Task-sized context

Main and dispatcher workers use the same inexpensive result-excerpt path. Large
model-facing tool text is kept in private session-bound artifacts; the model sees
a short excerpt with diagnostics and an exact original reference. It is **not**
a generated factual summary or proof of success. Small results stay exact.
Original error flags, structured programmatic results and images are preserved.
Nested codemode calls keep their complete results so scripts can filter/aggregate
before returning a model-facing result. No extra model call is made for this.

Workers/subagents execute coherent small work packages, not necessarily one tool
call. They have their own task session, not Main's full conversation. Their prompt
uses short worker guidance instead of the generated Main foundation and historical
MEMORY overlay. SOUL/identity, USER, voice/personality, unknown operator sections
and project/system instructions stay exact: do not silently summarize
away constraints. For Main too, the full historical MEMORY overlay is referenced
rather than injected en bloc; Main keeps bounded relevant working-memory recall
and explicit memory tools. A retained persona/history reference makes omitted
optional material retrievable. Automatic working-memory/adaptive-history injection is
skipped for children; relevant memory/skills can still be loaded explicitly.
Every new sequential step starts with a fresh native context, explicit previous
outcomes and retained original sessions; correction/recovery stays in the same
unsettled step context. Worker skill metadata stays indexed even on non-local
models. Skills are loaded when relevant, and the host/SDK catalog is not injected
twice.

Children are asked to return findings, changes, evidence references, uncertainties
and remaining work, not logs or loaded context. Long direct-worker/subagent reports
are retained and excerpted for the parent. Sequential step validators receive the
original report (including >64K reports) through the existing independent-assessment
budgeting path before the parent-facing result is shortened. Status tails
and selected diagnostic lines remain visible. The excerpt explicitly marks omitted
material, which is never evidence that an operation did not happen. Existing
execution assessment, authorization and cancellation semantics are unchanged.

Artifacts live under `sessions/tool-results/<session-key-hash>/<native-session-hash>/`.
Parent-facing reports use the exact child key as their run binding. Originals are
content-addressed `.txt` files; `.lines.txt` views add line breaks for bounded reads
of long lines. Files are private, persist across restart and are not deleted while
still referenced. No background cleanup or new model/service dependency is added.
If optional artifact storage fails, preserve the original output and continue;
never fail or repeat a completed effect because shortening failed. Parent-facing
durable results retain the existing 64K fallback bound with a marked head/tail
excerpt and reference to the retained child session, rather than bloating state
indefinitely. Dispatcher and subagent fallbacks keep tail blockers/uncertainties
visible instead of silently retaining only a success-looking report prefix.
A settled dispatcher effect reuses that exact durable result across restart;
optional shortening failure never authorizes another worker turn.

This is context efficiency, **not a 5,000-token total input limit**. There is no
per-request tokenization round trip, extra summary-model gate, or compulsory
new delegation hierarchy. Existing configured model/context budgets still apply.
The intended small local base-context target is not a claim that arbitrary
operator instructions or direct MCP schemas now satisfy a verified token ceiling.

## Stable request prefix

In ordinary Main/worker conversations, per-run host instructions (task revision,
provenance, language, recalled memory and the changing `MEMORY.md` artifact
reference) are appended as a hidden, persisted `harness-run-context` message at the current
conversation boundary, not substituted into the leading system prompt. Working
memory is snapshotted once per host run; SDK-step capture remains active but does
not rewrite the next request's prefix. The `MEMORY.md` reference is refreshed for
the next run; even an artifact-storage failure keeps its raw historical fallback
out of the system prompt. OpenAI-compatible backends that fold later
system messages into the head therefore retain the unchanged conversation prefix
across tool calls within a run. At a new host run the agent excludes obsolete
`harness-run-context` snapshots from provider input, including after session
resumption. This deliberately prioritizes bounded current instructions over an
append-only cache prefix across host runs: a hidden message is not automatically
excluded from model input. Append-only SDK context edits retire obsolete snapshots
from native pressure estimates and compaction inputs as well as provider requests;
all originals remain in the archive. Snapshot-only edits invalidate SDK usage, so
the agent conservatively retains the last measured pressure until a fresh response
or compaction replaces it. It does not fabricate provider counters.
The same rule applies to the per-run `harness-skill-reference` message (identical
catalog text re-attached on every run): only the latest one is active; earlier ones
are retired by append-only edits and stay in the archive. `harness-handover`,
operator messages and tool evidence are never retired.

The stable system policy identifies the latest run context as host-authored, not
operator input or new authority. Earlier contexts remain archived, not active
instructions; an empty new context clears previous per-run instructions. Memory stays untrusted reported
data. Native/external history, exact operator messages, live tool authorization
and cancellation guards are unchanged. Actual persona, tool or compaction changes
can still invalidate the prefix; this does not promise a particular backend cache
hit rate or change provider capability flags.

## Working result protocol and accumulation

The runtime injects one source-owned evidence protocol into ordinary Main,
Dispatcher-worker and Subagent system context, refreshed by the same persona
path as the working call. It distinguishes raw/structured receipts, excerpts,
worker-authored findings and independent verification; explains targeted
artifact reads and nested codemode filtering; and prohibits result-retrieval
replays. It contains no parent Dispatcher operation instructions.

The Dispatcher scheduler is host code, not a Main model conversation. Its
optional planner uses a separate tool-free planning prompt; execution workers
use their own sessions, compact worker guidance and the operator persona rather
than Main's full foundation/history. Main receives only short optional-delegation
guidance and current capability facts. Dispatcher submission and asynchronous
waiting instructions travel with the `plugin_dispatch` tool description (also
when discovered on demand); recovery details remain on the recovery tool. They
are not repeated in every system prompt or run context when the tools are absent.
Neither Dispatcher workers nor Subagents advertise the parent-only dispatch tool,
matching its existing rejection of calls from either child role.
Explicit operator-authored persona instructions are not rewritten by this split.
Existing authority, mandatory report formats and tool guards are not changed.

Workers may supply `hayate-task-report-v1` JSON with string arrays `findings`,
`changes`, `evidence`, `uncertainties`, `remaining`. This is synthesis by the
working model, **not** an additional summary-model request. Valid large reports
retain the exact original and project selected finding/change/evidence fields;
uncertainty and remaining-work arrays stay exact. Unknown report fields/formats
fall back to the ordinary honest excerpt path rather than being silently dropped.
Plain reports and explicitly required `STEP-STATUS` remain supported.

Many individually small tool payloads are subject to the existing soft
`toolResultPruning` budget too. Projection decisions depend only on each result's
original tool-text prefix. Results before that prefix reaches the budget stay
exact; qualifying new results after it are immediately excerpted with individual,
content-addressed original references and bounded head/tail/diagnostic text.
No growing aggregate index is inserted into an earlier result. The runtime also
runs advisory plugin projection at each result's own prefix boundary, not against
a changing future suffix. Thus `keepRecent` age transitions do not rewrite already
sent runtime messages; they are replaced by prefix-local immediate projection.
Standalone plugin users retain their existing policy API.

Every call/result identity, error flag, image and structured machine field remains
present. No native transcript is edited. Optional storage failure preserves the
input unchanged. Policy/strategy changes, genuine context compaction, or storage
failure/recovery can still cause a projection/cache boundary; ordinary appended
tool results do not. This is a soft tool-text preference, not a hard total-input
cap: retained below-budget prefixes are not retroactively shrunk to fit new work.
No extra model call or projection sidecar is introduced.

On local/unrestricted worker catalogs, permitted plugin schemas are discovered
by relevance with `tool_search`, including Dispatcher/memory/messaging tools;
only the maintenance escape hatch remains eager. Explicit allowlists and the
existing frontier-Main behavior are unchanged. Own reasoning/tool-argument deltas
also update bounded activity metadata without exporting private reasoning; an
open connection or another request's computation is never counted as progress.

## Targeted Read ranges

The ordinary `read` tool reuses the SDK's path resolution, access checks, image
handling and cancellation. Text results return at most 3,000 Unicode codepoints
plus a source path/hash, exact start/end cursors, total line count and `next`
arguments. `offset`/`limit` still select original file lines; optional `charOffset`
is a zero-based codepoint position within the starting line, so even a single
very long line can be read without shell fallbacks or missing text. This is a
bounded tool output, not a total prompt-token ceiling or an evidence summary.

These host-generated small ranges carry native result metadata with a matching
result hash. They remain exact through per-result, accumulated-budget and plugin
projection, including native/external session reopening. A file's own prose cannot
opt into this treatment. Other tools, errors, images and legacy results retain
their existing behavior. Old range snapshots do not depend on the current file;
new reads report a changed source hash rather than silently joining versions.

Choose the missing fact first, locate the relevant lines, then read that range.
Do not blindly page the full source or reread an excerpt to recover omitted
middle evidence. The range is complete only for its cursor interval, not proof
that omitted parts contain nothing relevant. This prevents automatic re-pruning
of targeted evidence; it does not prohibit a model from making redundant calls.

## Opt-in real-model probe

```sh
HAYATE_PROBE_BASE_URL=http://your-approved-backend:port/v1 \
HAYATE_PROBE_MODEL=your-explicit-model \
HAYATE_PROBE_OUTPUT=/private/probe-results \
node --import tsx scripts/probe-task-context.mts
```

The diagnostic has **no fixed overall deadline**. It records only request-local
text, reasoning, tool-argument or emitted-token progress as model activity.
Response headers, sockets, empty SSE frames and global GPU counters are not model
progress. Before the first own delta, queue/prefill is unknown, not a proven
stalled model. If the caller explicitly sets `LIVE_MODEL_IDLE_MS`, it applies only
after observed own model progress; the default does not invent an abort policy.
This detects lack of observable stream progress, not proof that invisible backend
computation stopped. SIGTERM/SIGINT cancels the diagnostic gracefully. Existing
production authority/deadline and transport policies are not changed by this tool.

For a vLLM backend, `HAYATE_PROBE_VLLM=1` adds a unique request ID and asks for
emitted token IDs so hidden reasoning also contributes observable progress. Do not
set it for other APIs without support. Synthetic payloads/results and task artifacts
remain under the diagnostic's output directory; credentials/headers are not logged.
Use `HAYATE_PROBE_API_KEY` only if the chosen backend requires authentication.

Observed isolated local fixture: two model requests, 1,585 and 2,517 reported input
tokens, one read-only fixture tool call returning 43,304 characters, final summary
733 characters. The successful turn took about 138 seconds in total; an old
90-second whole-turn test timer would have aborted it despite useful progress.
This is isolated model/tool evidence, not a claim of production activation.
