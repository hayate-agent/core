# Startup and cron efficiency

## Retained stopped tasks

The host reconciles all retained stops in one serialized ledger transaction before
restoring child execution. A no-op is recognized **inside** the writer queue and
after writable-owner validation, before cloning the ledger. Exact scoped children
are revoked; unscoped legacy children stay under an ownership hold. Preexisting
unscoped exceptions, original results, uncertain intents and checkpoints remain.
Only receipts belonging to revoked scoped children are removed.

Subagents publish changed stop/hold markers with one host save barrier. Already
completed/failed held legacy children do not cause a global host capture per old
mandate. Failed saves retain a pending obligation: changing a marker in memory is
not proof that revocation was persisted. Live cancellation still crosses the
publication barrier before interrupting a runtime. Runtime stop notifications do
not issue a second ledger cancellation after Harness has committed the fence.

Peter's historical state motivated this general path; there is no agent-name
special case and no pruning of completed/stopped evidence.

## Cron occurrence contexts

The stable `cron:<job>` key remains the owner of schedules, mandates, delivery,
source-reset fences and recovery. A new scheduler occurrence starts a fresh native
model transcript. The durable task stores its exact runtime session ID **before**
the first prompt; interrupted/continued occurrences reopen that ID rather than
continuing the newest unrelated occurrence. Context handover updates the binding.
A failed initial binding save yields to the existing host retry tick, not a tight
retry loop or a synthetic completed turn. A missing bound transcript fails closed.

For pre-upgrade unfinished tasks without an exact transcript ID, the host first
binds all such tasks to the exact existing shared transcript, with one durable
publication barrier before a new occurrence rotates it. Recovery can reopen that
retained context; old blocked work does not force every new occurrence to inherit
its history. Existing archives and effect evidence are not removed. Script-only jobs retain their existing no-model behavior.

The next fresh occurrence gets at most 2,000 characters of the last completed
result as explicitly untrusted comparison data, not a renewed instruction. This
is a result capsule, **not** a complete semantic source/delta cursor. Configured
jobs additionally receive a small `plugin_cron_checkpoint` source/work record:
exact source IDs/locators, observed cursor/time, unfinished items and evidence
references. Successful tool names can be preloaded from the currently permitted
catalog rather than rediscovered. Removed tools and host guards remain effective.

The checkpoint is staged, then published through the existing successful turn
settlement. A failed/interrupted turn does not advance it. A settled turn whose
report archival fails recovers its checkpoint without replaying the model/effects.
Each occurrence retains its configuration hash and revision basis; an old
unfinished occurrence cannot overwrite a newer occurrence's checkpoint. A changed
job is explicitly labelled for reconciliation rather than silently reusing its
cursor. Pending items are not delivery receipts: successful fetches do not imply
all items were handled, and no unchanged-source shortcut skips semantic/time-based
duties. Bounds reject oversized checkpoints rather than silently dropping items;
use exact retained evidence references for larger backlogs. This is a general
agent mechanism, not a source-specific incremental adapter.

Relevant working-memory recall remains independently bounded. This change does
not promise a 5k total provider request, fixed token saving or live latency gain.

## Existing per-agent host maintenance owners

These loops do not require Main to supervise housekeeping:

- Scheduler/Croner admits configured occurrences; source reset, pause and stop
  remain host fences.
- Dispatcher retry ticks and result/attention events own worker scheduling. Main
  does not need model roundtrips to ask whether a worker is still running.
- The existing 30-second memory connection/backlog timer retries durable capture.
- Local memory's separate worker scan owns reindexing and hourly bounded content
  maintenance; no second writer or housekeeping LLM is added.
- Working-memory capsules are bounded and captured on turn/step completion.
- Context maintenance executes at existing prompt/turn boundaries; Cron report
  processing retains its existing 30-second host owner.

Semantic consolidation/report analysis may use configured independent inference.
Mechanical checks do not constitute authorization for autonomous prompt, policy,
Cron or memory optimization. This patch adds neither a new polling agent nor an
RPC service. Overlapping report maintenance ticks coalesce into one existing
host pass; stop signals processors before draining that pass. Memory already has
its own single-flight durable backlog/retry owner, so no duplicate loop is added.

## Event-owned waits

While an eligible owned execution is ready/running, Main's persisted wait does
not cause periodic model calls to ask for its status. Dispatcher result, question
and assessment-attention events use the existing durable inbox and stable IDs.
Result acceptance is independent of the model's suggested polling window;
original task expiry, stop, ownership and semantic admission still apply. External
conditions without an owned worker retain the existing bounded wait mechanism.
This removes live-worker polling, not all semantic completion verification.

## Durable operator corrections

`plugin_operator_rules` retains exact clauses and original ingress provenance in
`<agent-home>/operator-rules/rules.json`, separately from historical memories and
learned recipes. Only an authentic current authorized operator input may mutate
it; child/cron/synthetic API work cannot. Authenticated external API ingress is
marked by the host, not model arguments. A separate semantic decision checks
enduring intent, attribution, negation, qualifiers and conflict replacement;
unavailable/invalid decisions do not publish. Original text and revision checks
remain enforced mechanically, including cancellation before atomic publication.

Main, scheduled sessions and delegated children receive the current rule book at
each run boundary in host tail context. Rules supersede contradictory recipes or
historical summaries, not higher-priority constraints or current corrections, and
grant no permissions. A persisted rule is not proof that an external document or
skill was corrected. Existing historical prose is retained, not silently rewritten.
There is no automatic import of assistant-written `binding` claims. Existing
corrections need authentic source-based acquisition; this change is not a blanket
migration of old conversations or a hardcoded receipt-language policy.
