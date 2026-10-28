# Dedicated review host / notification source dependency

This changeset reconciles two already authorized source mandates. It does not
silently add an unrelated feature to notification delivery.

The production plugin revision is the real, merged immutable
`56082f1bb0c03513b920a722b2e3cd2fdbfcd0cd` (plugins PR27). That revision also
contains PR26's mandatory dedicated-review executor contract. Current Core base
`eee4da08eeb3b2f3e671e1c7b11656faedfc65ed` did not implement that contract.
Therefore notification delivery with that genuine pin requires the dedicated
review host in the same compatible source candidate. Reverting enforcement,
using a hybrid lock, or falling back to generic working-context self-review is
not a compatibility solution.

The host implementation is adapted from the separate candidate
`74a76f82ad95643d2879edc986e3a2f9deb1cfae`, preserving dispatcher-worker,
dedicated-subagent and explicit handover-snapshot routes. Review verdicts and
budgets remain plugin-owned. The handover snapshot is not an actual runtime cwd
binding. Restart reconciliation of subagent provenance remains lazy until the
next review. These are documented nonblocking limitations, not new guarantees.

Notification routing requires an explicit `replyKind: routine` designation of
the entire reply and an unchanged persisted wait/next step. Missing or
substantive classification remains chat. A foreground operator answer steered
into a routine wait remains a normal answer. Registered materialized tool tests
cover this interaction for queue, steer and interrupt modes. The recipient-less
status deduplication cache and dropped status-adapter deliveryId remain known
nonblocking follow-ups; no optional changes are bundled here.

The current base retains Core PR141's live-parent result scope and PR142's
foreground priority/API settlement contracts. Multi-task checkpoints, Activity
and Cron behavior are retained and regression-tested. Open Core PR143 is a
separate dispatcher model-routing/settings mandate, not a dependency; its source
is not included. Neither is the separately owned wait-budget implementation.

Generated builtin plugins must be materialized from the checked-in production
lock and hash-verified remote source. Tests use an explicit test-only executor
for deterministic policy/ledger fixtures; production still fails closed without
a dedicated execution transport. Local tests do not constitute independent
review, publication or activation. The exact combined commit requires a new
parent-arranged independent review, without resetting prior review history or
budget. No push, PR, merge, configuration, restart or rollout is implied.
