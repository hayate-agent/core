<!-- SPDX-License-Identifier: Apache-2.0 -->

# Same-conversation maintenance interruption

Foreground channel/API input arriving during an interruptible maintenance model
operation requests cancellation of that operation. It does not abort a working
model turn or replay its tools. ContextMaintenance retains its per-key write lock
until the operation has actually settled. An adapter ignoring cancellation remains
blocking: a quick acknowledgement is not proof of a usable conversation.

Only assessment, compact and summary are interruptible. Archive writes, prepared
handover recovery, rotation, seed/checkpoint and archive linkage remain serialized.
No foreground prompt may bypass guidance's prepared-recovery check or its persisted
retry deadline. Failed recovery remains fail closed. Cancellation leaves admitted
intent pending and retains cooldown; retry occurs at an eligible later boundary,
not in an unmanaged background loop. No global maintenance policy is disabled.

PI compact/summary accept an optional AbortSignal. The adapter aborts native
compaction and also observes compaction_start: PI first awaits abort() and only
then installs its compaction controller. This event closes cancellation's setup
race. Cancellation awaits the underlying operation's cleanup before returning;
existing maintenance deadlines are unchanged. Custom strategies/adapters must
cooperate to provide this latency guarantee. Diagnosed baseline assessment forwards
the owner signal to its tool-free backend; arbitrary strategy code is not forcibly
terminated.

If interrupted before the original prompt, Harness retains that input (including
execution identity, continuation and absolute deadline), yields it to the accepted
foreground input, then retries it without repeating the successful beforeTurn
hook in that process. The accepted foreground skips optional model maintenance
for its own turn, but never guidance/recovery. If interrupted after generation,
the computed original reply commits normally, without replaying generation.
API turns remain separate. Host results remain evidence, not operator authority.
No persistence schema or restart budget is reset. Across a crash, existing durable
replay/recovery contracts apply; arbitrary external effects are not exactly-once.

Tests use temporary homes, a real Harness pump and a controlled fake maintenance
stall. The same test fails on the exact unmodified main base, then passes with
cooperative cancellation and no simultaneous prompt/maintenance. Separate PI
adapter tests cover cancellation before controller installation and after start;
restart tests cover pending admission, cooldown, retry and archive/seed uniqueness.
These are not live provider or production-compaction experiments.
