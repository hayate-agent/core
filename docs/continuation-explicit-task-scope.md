<!-- SPDX-License-Identifier: Apache-2.0 -->

# Explicit continuation scope (development slice)

`planContinuation(sessionKey, plan)` accepts optional `plan.taskId`. Omission
preserves the current-task default. Explicit selection must resolve to an eligible
stored task in the same session, with an original matching its existing anchor.
It cannot select unknown, foreign-session, terminal, terminated, expired or
unanchored tasks. Cross-task selection is limited to operator channel turns and
rejects pending dependencies/queued execution of that task. This selects a
checkpoint, not authority for tools in the current turn.

The bounded turn instructions list the current ID and up to eight eligible IDs
with original scope. `continuationTasks(sessionKey)` exposes that same view.
A subsequent default checkpoint still targets the actual current task. Completing
only a read-only question must name that question's ID (or use the unchanged
current-task default), not claim completion of a broader stored mandate.

The completion assessor receives the selected task's existing original anchor,
depth and deadline. It cannot choose another task ID. Settlement revalidates the
selection and uses the existing durable checkpoint/admission path; target depth,
original scope and deadline are retained. Existing wait deadlines cannot be
extended by targeting the task. There is no scan to revive waiting tasks and no
retroactive restart of expired fleet work.

## Exact uninstalled dependency

Core base: `5660b6fed7ca6e77e7fe06c6cbc0dbbb0bfb4c8a`.
Plugin base (the actual Core pin): `d3832140e51b9077816eac15826f27ada1a5b2c4`.
Plugin source: `/workspace/continuation-explicit-task-plugins/src/continuation-plugin.ts`.
The plugin adds optional `taskId` to the existing continuation tool and guidance.
Core must precede the adapter: an old Core ignores this field, so shipping the
adapter first could misbind a checkpoint. No plugin commit or production pin
change is part of this implementation-only task. After separate review and an
immutable plugin revision exists, a later authorized integration must update the
normal Core revision/hash lock. Nothing here is installed in the running agent.

Local verification only (leave checked-in `plugins.lock.json` unchanged):

```
node scripts/materialize-plugins.mjs \
  /workspace/continuation-explicit-task-plugins \
  /tmp/explicit-task-local-plugins.lock.json
node --import tsx --test test/continuation-explicit-task*.test.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

The local lock copies all production digests and changes only the digest of the
modified plugin source. It is a local-source verification manifest, NOT an
immutable release declaration. Standard pretest/pretypecheck rematerializes the
unchanged production adapter and therefore cannot verify the new tool field.
