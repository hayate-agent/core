# Nightly improvement controller (initial implementation)

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
not blind repetition of side effects. The Harness home lock owns this controller.

The prompt requires isolated experiments, baseline/acceptance criteria, tests,
review, licensing/provenance and read-only authorized study of other agents. No
foreign project reassignment or secret copying is permitted. Global pause is
respected. No extra experiment starts at the morning boundary; an active turn is
not forcibly aborted. Reports must not contain credentials or sensitive history.

## Scope and limits

This is a **scheduling and budget foundation**, not a completed autonomous research
system. The controller counts working Harness turns, not individual model calls,
review feedback calls or tokens. Interactive work can arrive after a night turn
started; it is not preempted or filesystem-isolated by the controller. Baseline
selection, worktrees, experiment evaluation and PR/merge operations are currently
agent instructions, not independently enforced structured evaluator gates. A
reported improvement is not verified scientific evidence. Do not use this as a
security boundary or unattended release authority until those gates are implemented.
`pullRequest`/`merge` express permitted workflow, not a capability sandbox. The
night session cannot use another conversation's archives/memory implicitly; only
explicitly authorized sources exposed by existing providers can be read.

Enabling the file only activates a version that contains this controller. Publishing,
merging and building do not update running installations. The five-minute work
heartbeat is separate from this controller and not a structured task/run watchdog.
