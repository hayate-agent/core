# Default work heartbeat

Established conversations with a reply destination receive an enabled five-minute
work heartbeat automatically on the first idle scheduler tick. Existing persisted
conversations migrate without a command. API run destinations and destinationless
internal sessions are excluded. The heartbeat only enters an idle conversation:
active turns, queued work, pending delivery, global pause and unsaved completion
prevent it. Loop scheduling retains precedence.

The default prompt checks explicitly authorized unfinished work, avoids duplicate
runs, respects approval/blocking states and emits NO_REPLY when nothing is safe to
continue. This is a contextual nudge, **not a structured task/run watchdog**. No
claim is made that it detects or repairs a stuck active run.

`/heartbeat status` inspects the schedule; `pause`/`resume` retain it. `clear` or
`stop` persist an opt-out so restart does not silently re-enable it. Setting a new
explicit schedule removes that opt-out. Existing custom intervals remain intact.
The idle tick initializes the schedule to five minutes in the future, avoiding a
startup burst. Updated product code must be deployed/restarted to activate this
behavior; editing source or building alone does not affect the running process.
