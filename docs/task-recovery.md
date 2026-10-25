# Durable task recovery after restart

The Harness stores the original accepted chat request separately from its inbox.
Its task checkpoint records the most recent continuation decision, concrete next
step, chain depth and inherited numeric deadline. Generated follow-ups carry the
same host-assigned task identity; unrelated scheduled work cannot update it.
A newer original chat turn replaces the session's task checkpoint.

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
semantic continuation decision become waiting; this is not a general natural
language task registry. A request interrupted before its first checkpoint uses
ordinary inbox replay. Existing installations without task checkpoints continue
using inbox replay; historical transcripts are not automatically converted into
permission to work. Task checkpoints begin with requests processed by this version.

Execution is at-least-once: a tool may have committed an external effect before
its result or completion checkpoint was saved. Recovery prompts require checking
actual state before retrying. This mechanism cannot undo effects or provide an
exactly-once guarantee for arbitrary tools. Storage must survive pod replacement;
Kubernetes termination grace must exceed the configured drain budget. A source
merge/build does not establish that the running deployment uses this feature.
