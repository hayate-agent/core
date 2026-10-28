# Worker notification routing

Routine dispatcher status uses `presentation: progress` and a stable logical
`native:status:*` ID. Questions, paused/blocked/cancelled executions remain normal
attention messages. New execution events capture their event-time state so a
queued `started` notification does not become an attention message merely because
the task subsequently blocked. Old ledger events conservatively use current state.
Successful results still enter the durable parent host inbox, with the existing
authority checks. They are not globally filtered.

The persisted-wait scheduler captures the previous condition and verification step.
Only a successful timer turn explicitly renewing the same condition and step AND
positively designating its entire reply `continuation.replyKind: "routine"` is
routed as status. `"substantive"` or an absent designation conservatively stays chat. Missing plans, changed conditions, completed/blocked plans,
failures and direct channel/API questions retain ordinary delivery. The original
reply remains in the durable outbox/turn settlement; status rendering changes its
presentation, not its retained evidence. No prose classifier or prompt-only quiet
instruction is used. A renewed wait can contain substantive intermediate evidence;
renewal alone therefore NEVER establishes that a reply is routine. Producers must
not designate partial results, errors, blockers or approval requests as routine.

Timer turns reuse the logical progress and native activity identity per task,
rather than producing a new Main activity row each minute. Timer model text is
not streamed into a conversation preview; tool events remain visible. An
unchanged displayed reply is deduplicated, including serialized restart; the
per-session successful-status cache is bounded to 128 entries.

## Required plugin dependency (not implemented in this candidate)

The pinned `harness/plugins` revision
`c8e2f9d20de6e8406ef1cf3bf984afe0d6499b64` continuation tool has a closed schema
without `replyKind`. The core API now accepts and validates the optional enum,
but the model-visible tool does NOT support it. No generated builtin, lock or
other checkout was edited. Consequently existing model timer renewals remain chat:
the original quiet-poll requirement is NOT fully implemented until the plugin
source legitimately exposes this enum and a published immutable revision/digest
is pinned and materialized in core. Plugin documentation must define `routine`
as a designation of the ENTIRE reply with no substantive result or attention
request; all other replies use `substantive` or omit the field. This is a routing
hint, never new authority. The parent must complete that dependency and exact
re-review before integration. Direct core tests of routine designation do not
prove the current model tool supports it.

## Adapter behavior and limits

* Matrix's existing editable-progress send path resolves one logical reference
  and sends replacements. This does not require nativeActivity to be enabled.
  Native activity already coalesces latest values (default 1 second), deduplicates
  text hashes durably and bounds its retained history. No generated plugin source
  or plugin pin is changed here. Matrix progress is implemented using message
  edits, not a truly ephemeral server-side tool widget. A missing edit reference
  can trigger the adapter's existing ordinary-message fallback.
* Harness TUI presents progress in its compact footer, not transcript entries;
  a new turn resets the status and a substantive reply replaces it normally.
* Console and third-party adapters without editable progress receive explicit
  progress-intent status text through `send`. They may render it as an ordinary
  line/message. Identical timer replies are deduplicated, but differently worded
  renewals can still produce multiple lines on these legacy adapters. There is
  no honest universal transient-display guarantee in the present Channel API.
  This fallback is deliberately visible rather than silently dropping evidence.

This change does not remove timer verification model calls or the 20-follow-up
limit, nor classify all arbitrary cron/host prose. A worker progress strategy's
free-text status is treated as progress unless the execution is blocked/paused
or asks a question; such strategies must use question/blocker state for required
operator attention. Actual host results and approval routing remain unchanged.
