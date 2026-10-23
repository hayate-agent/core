# Local interactive sessions

The Harness TUI starts a **new conversation on each launch**. It never automatically
continues `console:local`, global PI history, or another workspace's conversation.
The header shows the active conversation UUID, title and canonical workspace.
Model/provider authentication remains shared with PI; conversation history does not.

## Commands

- `/new [title]` or `/reset [title]`: create and select a fresh conversation; retain the old one.
- `/sessions`: list saved conversations for the current workspace, with UUID, title and creation time.
- `/resume`: open a selection dialog. `/resume <full-uuid>` resumes that exact conversation.
  The transcript is reconstructed from the selected runtime history's active branch.
  At most the last 80 user/assistant messages are displayed; the UI explicitly warns
  when older messages are omitted. Tool calls and thinking are not shown in this replay.
- `/title <name>`: persist a conversation's display name.
- `/status`: inspect the underlying runtime session/model/context.

Session controls are local UI actions, not prompts sent to the model. Switching is
blocked while the current conversation has running, pending, queued or undelivered work.
Use `/stop` and wait for completion before switching. Background goals and schedules
belong to their original conversation; switching does not cancel them. Output addressed
to another conversation is not inserted into the active transcript.

## Storage and ownership

Metadata is stored under `<home>/local-sessions`, mode 0600. Each conversation gets a
runtime directory under `<home>/sessions`, keyed by a canonical workspace hash and UUID.
Symlink aliases to the same workspace use the same catalogue. Different workspaces
have different catalogues. Each launch starts a different conversation.
The shared state ledger currently supports **one running process per Harness home**.
A home lock rejects a second TUI/gateway process rather than risking lost queue/state
updates. Stop the first process, or choose a separate `VANILLACORE_HARNESS_HOME` for
an independent instance. This is not concurrent multi-process session serving.
Per-conversation locks additionally protect opened runtime histories; ownership lasts
until clean shutdown, including sessions with background jobs after a UI switch. A crash leaves a lock deliberately: if resume
reports a stale lock, verify its PID is no longer running before manually removing that
specific `.lock` file. Never remove a live owner's lock.

Legacy `sessions/console_local` history is retained but never automatically imported or
resumed by the TUI. No files are deleted by migration. The line-based `run` gateway and
remote channel session routing are unchanged; these controls apply to the interactive TUI.
The catalogue does not yet provide archive/delete, search, or legacy import controls.

Session separation is **not a filesystem sandbox**. A model with read/bash tools can
still access files permitted to your OS user, including saved history. Use separate OS
accounts/containers and restricted tools if adversarial isolation is required.
