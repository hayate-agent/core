# Local worktree skill prompt metadata

A worker with a different execution cwd performs its own SDK skill discovery. The
primary-session `skillContext` optimization does not cover that cwd; actual local
worker snapshots contained 18,316 characters of full skill metadata after every
compaction, despite small working-context targets.

For an explicitly declared local model, the runtime now projects the **actual
SDK-discovered skill set for that session** into a private content-addressed,
line-readable catalog and bounded preview. This edits the public
`before_agent_start` per-run system-prompt options, not the SDK resource registry,
base options, project trust, tools, skill bodies, history or authority. Skill
expansion remains available. Frontier requests retain full SDK metadata. Reloads
use fresh discovery. No primary-worktree catalog substitutes for worker skills.

The discovered metadata fingerprint avoids rewriting an unchanged catalog. Every
request still opens the published catalog without following a final symlink,
checks regular-file/size constraints and verifies its content hash before hiding
original metadata. A missing, unreadable or corrupted catalog retains the complete
original SDK metadata for that request, clears the cache and retries publication
on the next request. Current persona/run instructions are refreshed even on this
fallback. This is a performance optimization, not an authorization gate; the SDK
catches extension-handler exceptions, so the adapter handles I/O failures explicitly.

Regression uses the actual SDK runner: all 30 fixture paths preserved, local
projection, unchanged file mtime, frontier restoration, reload, missing/corrupt
cache-hit fallback **and next-request repair**, and changed-discovery publication
failure without skill loss. No inference/network request is needed for these
prompt-projection assertions.

The change does not claim to solve shared-GPU queue saturation or irreducible
persona/schema overhead. Actual native session measurements and engine histogram
counter deltas are diagnostic evidence, not controlled before/after inference
acceptance. Preserve existing requests, manual stops and the disabled auxiliary
small-model service; do not clear queues or reroute providers to demonstrate speed.
