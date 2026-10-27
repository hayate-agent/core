# Native turn activity

Channels may implement the optional `taskActivity(to, event, input)` callback.
Plugin channels expose the same hook. This is best-effort host telemetry, not a
model prompt, durable message or grant of authority. No channel hook means no
transport output. Matrix may opt in using `MATRIX_NATIVE_ACTIVITY=true`;
`MATRIX_NATIVE_ACTIVITY_COALESCE_MS` controls coalescing (100–30000 ms, default
1000). A turn uses one stable progress-message reference: host status, tool starts,
parallel calls, completion and cancellation edit that same message. A new tool call
does not create another chat line. Parallel calls are summarized in that status;
it is a latest-value display, not a per-tool history. When native activity is enabled,
legacy gateway tool progress is suppressed even if configured, avoiding duplicate
progress messages. Dispatcher workers forward activity to their parent's external reply
channel only while the exact current claim is running and the parent is not
stopped. Obsolete tokens, mismatched session envelopes and internal dispatch or
subagent targets are ignored. The forwarded input is an empty synthetic host
envelope: worker task text is not forwarded as parent input, and no parent prompt
or authority is created. Transport callback errors do not affect settlement.

Matrix retains bounded deduplication hashes and in-flight call receipts beside its
sync state (`.activity.json`). On reconstruction a previously running call is
marked interrupted, not falsely reported as completed. Pending output is coalesced
and bounded; transient send errors remain retryable with stable transaction IDs.
This is best-effort telemetry, not a general durable outbox: a process crash can
lose unsent updates. Stop cancels future retry timers. These tests use a fake
homeserver; live Matrix one-message acceptance is not claimed.

Events carry hashed turn/tool-call identifiers, role/context, phase, measured elapsed
and inactive milliseconds and sanitized tool names. Tool arguments, results and
model text are excluded. PI tool lifecycle events additionally retain their original
call ID for host correlation; activity events expose a hashed ID.

Installation configuration:

```yaml
activity:
  enabled: true
  intervalMs: 30000
  maxAlive: 20
```

The interval accepts 1000–300000 milliseconds; maxAlive is an integer 0–120.
`enabled: false` disables events and the timer. Defaults match the example. No
runtime reload or persistence overlay is provided for these settings.

Progress follows runtime lifecycle; bounded alive events report inactivity without
creating working turns. Runtime return alone does not mark completion: the terminal
activity follows the turn commit hook. Failed commit emits failed telemetry, not a
successful completion. Shutdown closes observers even if the runtime does not settle.
Callback exceptions never fail execution. Events are not acknowledgements of remote
reply delivery and are not recovered/replayed as work after restart.
