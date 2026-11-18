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

For pre-upgrade unfinished tasks without an exact transcript ID, the host preserves
the shared context instead of guessing or clearing it. Fresh rotation is deferred
while such work remains unsettled. Existing archives and effect evidence are not
removed. Script-only jobs retain their existing no-model behavior.

The next fresh occurrence gets at most 2,000 characters of the last completed
result as explicitly untrusted comparison data, not a renewed instruction. This
is a result capsule, **not** a complete semantic source/delta cursor; a job that
needs exact issue/PR/source watermarks must persist those explicitly. Relevant
working-memory recall remains independently bounded. This change does not promise
a 5k total provider request, a fixed token saving or live latency improvement.

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
RPC service. Redundant semantic Main completion continuations remain a separate
optimization: they are not claimed fixed by changing the host's event loop.
