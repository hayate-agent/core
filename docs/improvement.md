# Nightly improvement controller (initial implementation)

Each night must select and try new bounded experiments, not recheck yesterday's
proposals as its output. Missing independent evaluator configuration prevents
automatic adoption, not isolated local experiments. The controller requests a
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

The optional controller is disabled by default. It reads `<home>/improvement.yaml`
on each scheduler check, without needing a configuration reload:

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

The prompt requires isolated experiments, baseline/acceptance criteria, tests,
review, licensing/provenance and read-only authorized study of other agents. No
foreign project reassignment or secret copying is permitted. Global pause is
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
merging and building do not update running installations. The five-minute work
heartbeat is separate from this controller and not a structured task/run watchdog.
