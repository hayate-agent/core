# Native turn activity

Channels may implement the optional `taskActivity(to, event, input)` callback.
Plugin channels expose the same hook. This is best-effort host telemetry, not a
model prompt, durable message or grant of authority. No channel hook means no
transport output. Matrix delivery and dispatcher-to-parent forwarding are not
implemented by this slice.

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
