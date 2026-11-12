# Local read-only session attach

This first slice observes an existing owner process, not a second runtime. It is
not a transcript viewer, interactive tmux terminal, administrative shell or remote
maintenance API. No TCP listener or administrative credential is introduced.

Opt in when starting the owner:

```sh
hayate-agent run --home /path/to/home \
  --observe-directory /path/to/private-observer --observe-session 'matrix:exact-key'
```

Both observation options are required. The owner fixes one exact conversation key;
clients cannot select another key. Unknown/not-yet-existing sessions produce null
status and are never created by observation. Use the actual Harness session key,
not a runtime transcript ID. No listener starts by default.

Connect from another local terminal:

```sh
hayate-agent attach /path/to/private-observer/observe.sock
```

The client prints JSON status lines containing running/prompting/queued/paused and
counts of retained task states. It does not load agent configuration, acquire the
home lock, open a runtime session or invoke a model. Ctrl+C detaches without
stopping the owner turn. There is no history replay or lossless event guarantee:
snapshots are coalesced and unchanged states are omitted. A slow client is
disconnected rather than accumulating an unbounded backlog; reconnect for current
status. No message text, task text, tool arguments/results or archive data is sent.

## Local trust and lifecycle

The directory must be a real directory owned by the process UID with mode 0700;
it is created if absent. The socket is mode 0600. These are local OS-account
permissions, not separate per-user roles or portable peer-credential authentication.
All processes running as that account share the trust boundary. Do not expose or
forward this socket to untrusted users. Client input is rejected. At most sixteen
clients are admitted concurrently.

Existing socket paths are never unlinked to force startup. Inspect a stale endpoint
and confirm no owner exists before removing it manually. Shutdown closes observers
and removes the owned socket; it leaves the directory. No observer detach cancels,
steers or compacts the conversation. Startup composition supplies the plugin only
an explicit read-only capability, not the Harness object or a forged console input.

Administrative control, durable pending maintenance, sanitized transcript display
and interactive input are separate future contracts. Commands requiring an idle
boundary are not made safe during tool execution merely by adding a socket.
Source merge/build does not activate this in an already running owner: rollout and
an explicit opt-in owner startup are required.
