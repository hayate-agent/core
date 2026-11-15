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
durable results retain the existing 64K fallback bound with a marked excerpt and
reference to the retained child session, rather than bloating state indefinitely.

This is context efficiency, **not a 5,000-token total input limit**. There is no
per-request tokenization round trip, extra summary-model gate, or compulsory
new delegation hierarchy. Existing configured model/context budgets still apply.
The intended small local base-context target is not a claim that arbitrary
operator instructions or direct MCP schemas now satisfy a verified token ceiling.
