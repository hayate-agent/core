# Exhausted productive budget: durable operator attention

The twenty-step productive budget is unchanged. Shell reads are not authenticated
status operations: a shell-based wait spends one productive step per recheck.
Only dispatcher status and continuation checkpoints have the existing exemption.

If a wait attempts work after exhaustion, the host adds one normal chat attention
notice to the durable outbox, with a stable delivery id and a task-level marker.
The notice and marker are saved together before delivery. Repeated denials and
restart do not create additional notices. Delivery retries use the same id; actual
transport exactly-once delivery still depends on channel idempotency.

A blocked checkpoint now preserves its supplied next step. At depth twenty it
records productive-budget termination without renewing authority or scheduling
work. Idle ticks reconcile legacy blocked exhausted tasks into the same notice,
not another model prompt. Stopped/completed/expired tasks are excluded.

Existing completed dependency events may still be consumed as data under the
original scope; no new productive delegation is permitted at exhaustion. An
unrelated or new explicit operator request is a separate task; it does not reset
or revive the old task. No completed worker effects are replayed.
