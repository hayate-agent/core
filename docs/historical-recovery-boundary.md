# Historical recovery enrollment boundary

An unresolved historical checkpoint is retained evidence, not automatic enrollment
for new work. On upgrade, before any channel/scheduler/dispatcher releases restored
inputs, the CLI applies a durable host-owned recovery enrollment boundary.

- New channel/operator tasks and explicit host mandates carry `current` enrollment.
- Previously unmarked tasks remain current only when a genuine unfinished
  channel/API ingress or an exact matching accepted/running worker proves ongoing
  ownership. The child task ID AND original mandate must match.
- Other nonterminal historical tasks become `held-legacy` / blocked, retaining
  their original state in `recoveryHeldState` and their existing checkpoint,
  deadline, evidence, budgets and permits for inspection.
- Restored generated continuation/wait inputs for held tasks are preserved under
  `heldRecoveryInputs`, not replayed or charged. Orphan generated task inputs are
  also held, not interpreted as fresh operator work. Genuine incoming user work
  and explicitly scheduled recurring work remain separate.
- Held tasks are excluded from autonomous startup assessment, dependency
  reconciliation, timer ticks, queue reconstruction, result-driven continuation,
  model task selection and execution. A model cannot enroll historical work.
- A newly elapsed polling window without a running child holds its checkpoint
  instead of becoming active again. It does not invent an operator expiry or
  erase/renew the old wait. A still-running exact child may retain monitoring.
- Unscoped workers never justify independent admissions for historical parents;
  matching a hash of unknown ownership cannot replace provenance.

The operator can inspect exact retained task state through `/task-budget inspect
<session-key> <task-id>`. An authenticated channel administrator may issue
`/task-resume <exact-task-id>` **in its owning conversation** to enroll one held
task for fresh independent assessment. Host/API/model messages cannot invoke this
authority. Stops, expired authentic deadlines, exhausted budgets, active sessions
and failed persistence reject resumption. The old archived input is never replayed
by this command. Nothing is bulk resumed, marked completed, cancelled or deleted.

This is a conservative one-time legacy boundary, not an arbitrary age TTL. The
runtime's normal exact-owner recovery continues for current enrolled tasks. The
boundary is idempotent and persists before external owners can start work.
