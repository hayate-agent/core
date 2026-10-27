# Durable task recovery after restart

For explicitly submitted background executions, see the separate
[durable dispatcher ledger](dispatcher.md). Dispatcher worker turns are excluded
from ordinary inbox/continuation replay, even when dispatcher mode is disabled;
ambiguous opaque worker effects must be reconciled through their ledger.

The Harness stores the original accepted chat request separately from its inbox.
Its task checkpoint records the most recent continuation decision, concrete next
step, chain depth and inherited numeric deadline. Generated follow-ups carry the
same host-assigned task identity; unrelated scheduled work cannot update it.
A newer original chat turn has its own task checkpoint; it does not erase earlier
mandates. The persisted `tasks` collection retains them independently of the latest
`task` compatibility pointer. Old single-task snapshots are accepted unchanged.

On startup, after channels are ready, an active checkpoint with a concrete next
step can reconstruct one durable continuation if no current/queued input exists.
The ordinary durable inbox takes precedence, including a continuation already
saved before shutdown. Reconstructed work is saved before release. Global pause
still prevents execution. `/stop` stores a stopped task even without a running
turn. Waiting, blocked, completed, stopped, expired and exhausted checkpoints do
not start work. Controller-owned nightly work remains with its own controller.

A continuation is replayable input even when its transport source is heartbeat.
This closes a previous gap where generated follow-ups were omitted from inbox
snapshots. A repeated restart must not manufacture additional parallel steps.
The existing crash replay cap, approval and execution-boundary checks still apply.

Recovery does not invent a next step. Successful turns with no explicit or
semantic continuation decision remain active for one durable independent assessment
against the original mandate. An uncertain or unavailable decision does not authorize
execution. Explicit waiting, blocked, completed and stopped decisions remain distinct;
missing a continuation tool call is not an instruction to wait.

At queue-empty prompt boundaries and scheduler ticks, a concrete retained step is
claimed once into the durable inbox. Intermediate questions are answered first, then
the original work resumes, even when the question arrived during a working turn.
Completion of the question cannot complete another task. Live, paused or blocked
background executions suppress execution of their associated task, not independent
assessment or unrelated retained work. Legacy executions without a task identity
conservatively suppress all autonomous execution. Completed host results are
matched to their original task identity rather than the latest question.

Independent post-turn assessment also runs for explicit continuation and timed-wait
checkpoints; its result does not overwrite an already scheduled step or wait timer.
Other active retained mandates lacking a next step are assessed separately against
their own original authorization. The host supplies bounded evidence (last eight
user/assistant excerpts, up to 2000 characters each, and up to eight retained task
summaries), persisted across restart. The bundled plugin interprets that evidence;
it cannot turn historical context into new authorization. Existing terminal/stopped
tasks are not automatically resurrected. No full transcript reconstruction or
arbitrary inferred parent-child relationship is claimed here. `/stop`
revokes all retained mandates in the conversation. Pause, deadlines, chain limits,
controller exclusions and durable-save-before-execution remain enforced. There is
no natural-language cancel/supersede inference: use explicit stop/pause controls. A request interrupted before its first checkpoint uses
ordinary inbox replay. Existing installations without task checkpoints continue
using inbox replay; historical transcripts are not automatically converted into
permission to work. Task checkpoints begin with requests processed by this version.

In either mode, ordinary turns (including managed-subagent turns) share
`executions.json` with dispatcher executions. A stable turn ID is saved before
execution. Terminal reply/continuation/goal and consumed steering-input state are
settled there before the inbox/outbox completion snapshot. Restart in that commit
gap restores the saved result without another runtime prompt. Unsettled ordinary
turns still follow the existing inbox replay policy; this does not silently
upgrade arbitrary model/tool effects to replay-safe operations. A stop racing the
asynchronous settlement write marks that turn stopped in the same ledger; either
commit order suppresses successful reply delivery and continuation. Recovery also
honors a stopped turn whose final result was not yet saved. This revocation does
not undo side effects already performed.

Execution is at-least-once: a tool may have committed an external effect before
its result or completion checkpoint was saved. Recovery prompts require checking
actual state before retrying. This mechanism cannot undo effects or provide an
exactly-once guarantee for arbitrary tools. Storage must survive pod replacement;
Kubernetes termination grace must exceed the configured drain budget. A source
merge/build does not establish that the running deployment uses this feature.
