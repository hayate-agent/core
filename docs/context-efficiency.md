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

## Working result protocol and accumulation

The runtime injects one source-owned result protocol into ordinary Main,
Dispatcher-worker and Subagent system context, refreshed by the same persona
path as the working call. It distinguishes raw/structured receipts, excerpts,
worker-authored findings and independent verification; explains targeted
artifact reads and nested codemode filtering; and prohibits result-retrieval
replays. It also explains required Dispatcher submit arguments and yielding
for asynchronous results instead of an unchanged status-polling tool loop.
Existing authority, mandatory report formats and tool guards are not changed.

Workers may supply `hayate-task-report-v1` JSON with string arrays `findings`,
`changes`, `evidence`, `uncertainties`, `remaining`. This is synthesis by the
working model, **not** an additional summary-model request. Valid large reports
retain the exact original and project selected finding/change/evidence fields;
uncertainty and remaining-work arrays stay exact. Unknown report fields/formats
fall back to the ordinary honest excerpt path rather than being silently dropped.
Plain reports and explicitly required `STEP-STATUS` remain supported.

Many individually small older tool payloads are subject to the existing soft
`toolResultPruning` budget too. Private exact payloads are retained with a scoped,
content-addressed index; result bodies refer to indexed records while every
call/result identity, error flag, recent result, image and structured machine
field remains present. No native transcript is edited. Storage/index failure
preserves the input unchanged. This is a tool-text projection preference, not
a hard total-input gate or a guarantee that irreducible evidence fits a limit.

On local/unrestricted worker catalogs, permitted plugin schemas are discovered
by relevance with `tool_search`, including Dispatcher/memory/messaging tools;
only the maintenance escape hatch remains eager. Explicit allowlists and the
existing frontier-Main behavior are unchanged. Own reasoning/tool-argument deltas
also update bounded activity metadata without exporting private reasoning; an
open connection or another request's computation is never counted as progress.

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
