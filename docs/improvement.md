# Nightly improvement controller

## Strategy ownership

The bundled work prompt, experiment receipt parser/deduplication, productivity and
completion decisions, and bounded report renderer are owned by [hayate-agent/plugins](https://github.com/hayate-agent/plugins).
Core retains calendar scheduling, durable turn reservations/window checks, inbox/
outbox coordination and the infrastructure-pinned evaluator/process runner. Existing
state files and report archives require no migration.

`nightlyStrategy: plugins/my-night.mjs` selects a trusted local startup ESM default
export implementing `{apiVersion:1, prompt, completed, receipts, unique, report}`.
`prompt(policy, turn)` returns work instructions. `completed(progress, reply)`
updates a copy of experiment conclusions (experiments, recentHypotheses,
noExperimentTurns, done, results); it cannot accidentally overwrite host reservation
fields through that object. `receipts(reply)` and `unique(receipts)` prepare reported
evidence; `report(state, timezone, receipts, artifact)` renders the remote summary.
Use the bundled source as the exact typed contract example. Invalid/missing modules
fail startup, never silently fall back. Class methods retain receivers.

These are trusted in-process pure methods, not a sandbox or new authority. They must
not start receivers/background resources, falsify evidence or bypass the operator's
scope. The controller requires explicit strategy injection when embedded; CLI
injects the bundled default. The evaluator remains infrastructure-pinned, not replaceable by
this strategy selection. Merge/build is not running activation.

### Delegated results are evidence, not new work admissions

Nightly dispatcher results are adopted directly from the canonical execution
ledger, idempotently per execution ID. They never enter the generic parent LLM
result lane. Late results can therefore be retained after the window ends or the
night closes without raising a spurious window/budget error, spending another
turn, reopening a closed night, or replaying a completed worker. Startup also
reconciles already-completed ledger results, including pre-upgrade deliveries.
The existing window, turn budget, pauses and independent closure authority remain
unchanged; child markers cannot close the parent night. Only receipts bound to
that night's already-reserved turns are adopted.

A parent turn waiting for delegated work is not an empty experiment attempt.
Pending workers defer the next nightly turn while the work window is active;
completed evidence is supplied to the next normally authorized nightly turn.
Routine background dispatcher lifecycle rows stay silent, while questions and
recovery blockers still require attention. Ordinary user/API work is unaffected.

### Two delivery streams, not local-only success

Delivery belongs to the authorized improvement mandate:

1. **Skills/instance:** configuration, skills and extensions go to their assigned
   agent/configuration repository and established deployment path.
2. **Private product variant:** agent-specific Core, WebUI or plugin-source
   adaptations may remain in an assigned non-upstream repository as immutable
   bases plus versioned patches/source, tests and a reproducible artifact. They
   must survive base upgrades through explicit composition, not installed edits.
3. **Shared product contribution:** generally useful changes may go to upstream
   deliberately; touching product source does not itself mandate publication.

Product source changes need independent external review of the actual changed
stand before integration/live activation, including private variants. Self-review,
CI or a different merge login alone are not that review. The existing external
review workflow supplies evidence; Forgejo required approvals remain0. Missing
review is an external blocker, not authorization to self-approve. See
[agent variants](agent-variants.md) for the reproducible update/review contract.

Resolve owners from installation/repository metadata, SOUL and actual Git remotes;
never invent repository authority or credentials. Existing operator PR/merge
settings and repository protection still apply. Proven good changes should be
committed, pushed and handed into that existing integration process, rather than
left as a local proposal. Check existing commits, branches and PRs before acting;
unknown effects are reconciled, not retried blindly. Reject unsafe candidates.

An optional `delivery` on an experiment receipt records reported `stream`
(`upstream`/`variant`/`instance`), `status` (`local`/`pushed`/`integrated`/`deployed`/`blocked`),
actual repository URL, branch, full commit SHA, optional PR URL, deployment evidence
or a concrete blocker/next step. Published states require branch and commit;
deployed also requires deployment evidence; blocked requires a reason. Malformed
or credential-bearing remote claims are discarded as delivery evidence, while the
underlying experiment remains readable. These are **reported facts**, not a
host-side Git/API verification or authorization grant. The working agent must
verify remote state, and closure review must distinguish actual evidence from
status assertions. Pushed is not merged; merged is not deployed.

The host refuses successful closure for improved work with missing/local-only
handoff evidence, without consuming another reviewer attempt. Genuine external
review/release/access blockers may end active work, but remain explicitly pending,
not deployed. Morning reports separate these states. Night-window/turn/pause
limits are unchanged, even if delivery remains unfinished.

Unactivated improvements survive rollover in `deliveryBacklog`, separate from
new experiments and recent-hypothesis counting. On the first compatible load,
validated prior `improvement/reports/YYYY-MM-DD.json` receipt arrays are also
imported as historical candidates; matching current experiment identities are not
duplicated. No effects or old budgets are replayed. Non-readable, malformed or
oversized (>8MiB) archives remain untouched and are surfaced by archive name in
`deliveryImportIssues` and the report rather than silently declared delivered. At the next normally authorized
night turn they are supplied before new experimentation; concretely blocked items
are not prioritized ahead of actionable work. A delivery receipt for the same
hypothesis/baseline/candidate updates existing evidence without another experiment.
Forward delivery updates from completed workers can also be adopted after the
window closes, without running another model turn or reopening the night. Later
safety review can reject a retained candidate. Full backlog remains in state and
report archives; prompt/report excerpts are bounded. Legacy evidence without a
remote receipt is **unverified**, not proof that no publication ever happened.

### Between-night local selection

The administrative `/nightly-strategy` plugin supports `status`, `use <module>`,
`disable`, `baseline` and `reload`. Paths are trusted executable local modules,
relative to Harness home (command grammar does not support whitespace in paths).
The controller reserves both its asynchronous tick and the Harness idle boundary;
queued/running owner work, pending night turns or unreported results reject changes.
There is no mid-night strategy migration. Validation and durable settings save
precede publication; failures keep the active generation. Disable prevents new
night state/reservations, not just prompts. It cannot strand an unfinished report
because such a change is rejected until the old report is adopted.

`settings.local.yaml` stores `nightlyStrategy`: path selects, null disables, absence
restores the captured installation baseline. `baseline` restores that startup
instance; `reload` reloads only an explicitly selected entry module. Transitive
imports retain Node ESM cache semantics; imported generations remain until exit.
All five methods are receiver-bound. Imported code is trusted: side effects during
an unsuccessful import are not rolled back.

New nights persist their local selection path. Startup restores a matching pending
night without applying the between-night switch restriction. Mismatched or disabled
selection with unresolved state fails startup without rewriting the old state.
Legacy state without selection identity permits only the installation baseline;
restore that selection to finish its report before switching. The identity is NOT
a code digest: editing module contents or installation config across restart can
change behavior and requires operator discipline. No immutable-code or exactly-once
crash guarantee is implied. An adopted night cannot resume if the clock returns to
its old window. Host calendar, turn budget, authorization and evaluator are unchanged.

After actionable delivery backlog is handled or concretely externally blocked,
select and try new bounded experiments. Delivering existing good work is productive
but is not counted as a new experiment. Missing independent evaluator configuration
prevents evaluator-based automatic adoption, not authorized commits, publication
through the existing repository workflow, or isolated local experiments. The controller requests a
structured `improvement-experiment` JSON block with hypothesis, baseline,
candidate, evidence and outcome (`improved`, `rejected`, `inconclusive`). These are
reported experiment receipts, not independently verified measurements or merge
authorization. Recent normalized hypothesis strings (200 retained) are included
in subsequent prompts; exact repeats do not count as new experiments. This is not
semantic duplicate detection and does not prevent paraphrasing.

Morning reports are rendered from complete validated receipts, not concatenated
model replies. Exact normalized hypothesis duplicates appear once. Raw replies
remain local diagnostic history (legacy entries may be truncated); they are never
used as remote report markup. Every report first archives all structured receipts
under `improvement/reports/<night>.json`, including when a remote destination exists.
Archive failure leaves the night pending and does not publish a partial report.
The remote summary has an explicit turn/experiment/outcome count and includes only
whole JSON blocks within a bounded body; overflow points to the full local artifact.
It labels measurements as reported, not independently verified. A report artifact
marked `outbox-pending` is not a delivery acknowledgement.

A bare `[IMPROVEMENT_DONE]` without a new receipt does not finish the night.
Three consecutive turns without new receipts stop the loop with an explicit
failed-night diagnostic rather than pretending success or spending all remaining
turns on repeated status checks. Blockers must be reported honestly; receipts must
never be fabricated to satisfy the guard. The normal time/turn budget still
bounds work.

The controller policy is enabled by default, including when `<home>/improvement.yaml`
is missing or omits `enabled`. An explicit `enabled: false` opts out and is preserved.
Defaults remain 23:00–05:00 in the Harness timezone (UTC without an override),
20 turns, no implicit `pullRequest` or `merge` restriction, no evaluator and no
report destination. An absent PR/merge setting is neither a prohibition nor a
permission grant. Explicit boolean settings are reported as operator configuration.
The prompt does not add mandatory review, evaluator-gated merge or GitOps-only
rollout. Default enablement grants no new project access or delivery authority. A configured nightly
strategy is still required. Reports use an explicit `reportTo`, then the Harness
home address, otherwise local-only storage; no channel broadcast is inferred.
The controller reads the policy on each scheduler check, without needing a
configuration reload. The following is an explicitly expanded operator policy,
not the product defaults:

```yaml
enabled: true
startHour: 23
endHour: 5
timezone: Europe/Berlin
maxTurns: 200  # product default: 20
pullRequest: true
merge: true
reportTo:
  channel: matrix
  target: '!your-room:example.org'
```

State is stored in `<home>/improvement/state.json`. Reservations are durable before
working-model execution; interrupted attempts consume budget. The controller
starts only when other conversations have no active/queued turns. It stops starting
new work outside the configured local-hour window and supports an early completion
marker. DST uses local calendar dates. A morning report goes through Harness outbox
at the first idle check after the window ends, also after restart. A crash between
outbox adoption and marking the report can produce a duplicate report (at least
once, not exactly once). On restart interrupted candidates require state inspection,
not blind repetition of side effects. If neither `reportTo` nor Harness home address
is available, results are durably retained in `improvement/reports/<night>.json`
with `delivery: local-only`; this is not remote delivery. Only a successful local
write releases the old night so subsequent nights can run. Local-only reports are
not automatically sent if a destination is configured later; retention is manual.
The Harness home lock owns this controller.

The prompt requests baseline/acceptance criteria, tests and licensing/provenance.
The operator's task, SOUL and explicit settings define project scope and delivery
workflow; the strategy does not impose a separate blanket foreign-project ban. Global pause is
respected. No extra experiment starts at the morning boundary; an active turn is
not forcibly aborted. Reports must not contain credentials or sensitive history.

## Independent experiment measurement

An optional infrastructure-owned evaluator is configured as:

```yaml
evaluator:
  runner: /read-only-policy/evaluator.mjs
  sha256: <64 lowercase hex characters>
```

`plugin_improvement_evaluate` is available only to the nightly conversation during
its enabled window. It accepts full baseline/candidate commit IDs, a hypothesis,
metric, direction and minimum improvement. The pinned evaluator's captured source
runs unchanged against two temporary detached worktrees. It receives the worktree
path and metric as arguments and emits JSON `{ "score": 10, "checksPassed": true }`.
Regression failures reject a candidate; invalid baseline, invalid output or timeout
are inconclusive; ties are rejected. Evidence is written under
`improvement/experiments/`. Only one comparison runs at a time. No merge is performed
by this tool. Worktrees are not an OS sandbox: an evaluator executing candidate
code must arrange external isolation and credential removal itself. The runner
must be self-contained; pinning one source file does not pin imported dependencies.
A metric must be chosen and governed independently to avoid benchmark gaming.

Runner stdout and stderr share a 64 KiB output budget. On POSIX the runner is
started in its own process group; timeout, excessive output or leader exit kills
ordinary descendants still in that group, including after successful execution.
On Windows only the direct runner is terminated. Descendants that create a new
session/group can escape this cleanup; inherited pipes from escaped descendants
may still prevent completion. This is resource cleanup, not process isolation or
a guarantee against hostile code. External sandboxing remains necessary.

Cleanup attempts each registered worktree independently. An incomplete cleanup
forces an `inconclusive` result, preserving completed measurements in final evidence.
Evidence includes internal recovery paths (`cleanup.remainingWorktrees` and
`cleanup.retainedRoot`); these paths are not runner output. A retained root is not
recursively deleted while Git worktree removal has failed. Operators must recover
these resources explicitly. Final evidence-write failure can still reject the call;
this is not a transactional filesystem/resource cleanup guarantee.

## Scope and limits

This is a **scheduling and budget foundation**, not a completed autonomous research
system. The controller counts working Harness turns, not individual model calls,
review feedback calls or tokens. Interactive work can arrive after a night turn
started; it is not preempted or filesystem-isolated by the controller. Baseline
selection and PR/merge operations remain agent instructions. Independent measurement
and detached worktrees are available via the optional evaluator, but its verdict is
not yet wired into an enforced adoption/merge gate. A
reported improvement is not verified scientific evidence. Do not use this as a
security boundary or unattended release authority until those gates are implemented.
`pullRequest`/`merge` express permitted workflow, not a capability sandbox. The
night session cannot use another conversation's archives/memory implicitly; only
explicitly authorized sources exposed by existing providers can be read.

Enabling the file only activates a version that contains this controller. Publishing,
merging and building do not update running installations. The controller's five-minute calendar tick retries a missed nightly start only
inside the configured window. It retains the same night ID, turn budget, pause,
foreground and strategy guards; completion callbacks remain state-only. Scheduled
tick failures log only a fixed error class (never exception text/stack), at most
once per five minutes per controller, and the next tick can retry.

The five-minute work heartbeat is separate from this controller and not a
structured task/run watchdog.
