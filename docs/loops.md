# Conversation loops

`/loop` and the bundled `plugin_loop` tool manage the same conversation-local
schedule. The tool has no conversation selector: runtime context determines scope.
It is available with explicit non-empty tool allowlists; `tools: []` disables it.

Actions: `status`, `set`, `pause`, `resume`, `stop`. `set` replaces an existing
loop and requires `prompt` (1..4000 characters) and `everyMs` (safe integer,
at least 60000). Optional positive safe integer `times` bounds executions.
The first execution is eligible on the next idle tick. A running turn is never
interrupted. No calendar deadline is inferred from prompt text: use a finite
`times` or explicitly stop the loop.

Set, pause and stop discard queued inputs whose source is `loop` in this
conversation; unrelated inputs remain. Stop does not stop heartbeat, Cron,
continuation tasks or a currently executing turn. Resume preserves the previous
next-at timestamp, so overdue work is eligible on the next idle tick.

Mutations await the Harness state persistence callback before reporting success.
Without persistence they fail before mutation. On a write error the requested
in-memory change remains (particularly a stop remains stopped), but the tool
reports failure: restart durability is not confirmed. Retry or resolve storage
failure before claiming completion. Status is an in-memory snapshot, not a disk
verification. This interface does not introduce cross-process ownership or
transactional isolation from concurrent external commands.
