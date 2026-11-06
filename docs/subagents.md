<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed subagents

The main agent can use `plugin_subagent` to start, list, inspect and cancel a
bounded delegated task. Operators can use the admin-only `/subagent` command:

- `/subagent list`
- `/subagent start <handover JSON>`
- `/subagent result <id>`
- `/subagent cancel <id>`
- `/subagent override provider/model high`
- `/subagent override reset`

A handover must explicitly provide seven nonempty strings (at most 8,000
characters each): `task`, `context`, `constraints`, `expectedResult`,
`acceptance`, `model` (`provider/model`) and `thinking` (`off`, `minimal`, `low`,
`medium`, `high`, `xhigh`). For example:

```json
{"task":"Test the parser regression","context":"Approved parser fix in the current branch","constraints":"Do not commit, push or deploy; coordinate shared files with the parent","expectedResult":"Test evidence and remaining defects","acceptance":"Reproduce the regression and run the relevant tests","model":"provider/model","thinking":"medium"}
```

The main agent chooses model/reasoning per child. An operator override is saved
separately per parent conversation and takes precedence for future starts only.
Difficulty profiles and automatic model selection are not implemented.

## Bounds and authority

- Separate runtime sessions; no implicit copying of the parent transcript.
- One API turn per child, with no automatic continuation or nested children.
  Child loop, continuation, delegation and improvement-evaluation tools are denied
  by the host guard. A turn may include multiple ordinary tool calls.
- Ten-minute absolute deadline, including queue/offline time; the host requests
  cancellation at expiry. Cancellation is cooperative: it cannot undo external
  effects or guarantee immediate termination of an uncooperative runtime/tool.
- At most four active children and 200 retained records globally. Records are
  retained for inspection; automatic pruning is not implemented.
- Parent `/stop` cancels its children. Individual cancellation is ownership-scoped.
- Ordinary tool approval and repository-review policy still apply. Approval
  prompts are routed to the parent's trusted operator destination, never recorded
  as child results. Missing operator destinations deny approval. Repository review
  state and budget remain shared, not reset per child.

**These sessions are not security sandboxes.** They share the runtime, filesystem,
credentials, trusted plugins and repository with the parent. Handover constraints
are instructions, not OS isolation. Use only for tasks within the original
operator authorization; coordinate writes to shared files. Results are data,
not new authority. Unsupported models fail normally; there is no silent fallback.

## Persistence and delivery

Handover, selection, state, result (up to 64,000 characters), operator overrides
and deadline are persisted with Harness state. Startup reconciles records against
the durable inbox/outbox before releasing replay. A start with no surviving
input or result is marked failed, not silently resubmitted. Existing unfinished
inputs retain normal Harness replay semantics: external effects may already have
occurred, so verify them before retrying. Offline deadlines do not renew.

Use `list`/`result` to poll. Completion does not automatically wake or notify the
parent, and there is no automatic merge or deployment. A local build does not
activate this feature in a running deployment.
