# `/new` and `/reset`: stop old work, then start fresh

Both commands revoke the previous work owned by the exact gateway conversation:

- Abort and drain the old parent turn; discard its queue and late reply.
- Persist stops for durable tasks and continuations, including waiting/blocked work.
- Revoke and drain its Dispatcher workers and subagents through the existing scoped stop hooks. Late results cannot reauthorize or restart the old mandate.
- Clear conversation-owned loops, heartbeat and standing goal; disable inherited heartbeat for this conversation.
- Pause scheduled jobs with exact creator provenance (`origin.platform`, `chat_id`, optional `thread_id`, and captured `user_id`). Persist their disabled override, abort/drain their running script, and reset their `cron:<name>` sessions and children too. A matching delivery address alone is NOT ownership; a provenance/name collision fails closed.
- Clear the old retry input, recent prompt context and hashtag-reference cache before opening fresh runtime history. Stopped tasks are not automatic topic candidates.

Other conversations, other gateway/thread keys, independent installation schedules, global memory and archived task/effect evidence are not erased or stopped. Completed external effects are not undone. Independent scheduler jobs are not classified as conversation-owned merely because they deliver to its address.

This intentionally replaces the former context-only reset. For context rollover that preserves an authorized task, use the separate handover/context-maintenance mechanisms, not `/new`.

The reset marker is durable before interruption. The private control request has no idle timeout during the owned drain rather than the ordinary 10-second idle limit; a noncooperative owned script can take its existing execution deadline to settle. No success is acknowledged before the drain finishes. Tool and admission fences survive cancellation/drain/open/persistence failure, including a subsequent `/stop`. A failed reset does not claim success: retry `/new`; startup finishes a persisted reset before admitting workers. New context is never opened over a still-running old parent.

TUI `/new` and `/reset` use the same revocation before creating their new local conversation.

The existing private same-UID operator-control socket also accepts exactly `{ "op": "reset-conversation", "parent": "<exact conversation key>" }`. It calls the same reset path; no worker-parent keys or extra fields are accepted. This is a host-maintenance control, not a model tool or a network endpoint. It permits an operator to honor a previously issued reset after a software repair without fabricating a user message or replacement execution.
