# Retained work recovery

The host retains explicit task mandates across turns, handover and process restart.
An ordinary turn without a model checkpoint does not universally lose authority.
Recovery uses the existing bounded completion checker, not a separate periodic
history-reading agent. Only retained active mandates can be assessed; history and
worker results are evidence, not new authorization.

Recovery inference is claimed durably before calling the checker. Its decision
and a host-owned admission (task/depth, exact next step, original mandate and
expiry) are persisted together. A crash before inbox admission is therefore
recoverable without repeating inference. Queue admission and inbox persistence
still use the normal host barriers; task depth is charged by the completed turn.
Restored inboxes retain their identity rather than creating another execution.
Before execution, admission is checked against current authority again.

A claimed-but-interrupted assessment, an unavailable checker at startup/idle,
an inconclusive decision or a mismatched admission blocks automatic work. A stable
recovery attention ID and an outbox notice (when an address exists) are persisted;
restarts do not regenerate that escalation. Without a destination the blocked
state and attention ID remain locally inspectable. Explicit operator reconciliation
is required. A classifier-less ordinary foreground turn is not itself a recovery
boundary.

Stopped, completed, blocked, expired, externally recovered and nightly-improvement
work is not revived. Pending dependencies (including paused/proposal-only children)
prevent inference and autonomous admission. Global pause, persistence barriers,
existing 20-step productive budget, tool permissions and review gates still apply.
Concurrent assessments of one retained task are serialized in the host; a changed
mandate, depth, deadline, state, owner or dependency invalidates the stale decision.
No transcript is exported to another service by this repair.
