<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hashtags: identification is not context isolation

## Decision

Hashtags suffice as searchable references and visible assignment labels. They do
**not** suffice to isolate topics, model history, memory, permissions or execution.
Do not implement a second routing/context architecture as part of status labels.

## Evidence and bounded reproduction

`test/hashtag-activity.test.ts` runs the real Harness with a deterministic runtime
(no provider/model call) and the canonical native activity renderer:

- `topic A #alpha`, then `topic B #beta` on `mem:room1` opens exactly **one**
  runtime session. Both prompts enter the same session object. Recall receives
  `mem:room1` twice, never a tag-derived key.
- The very first `starting` activity already carries the exact assignment tags.
  Final activity renders `#alpha · Main …` and `#beta · Main …` respectively.
- A late A activity after B still renders A. A retained worker execution after
  store reload renders A despite B being the latest parent input and despite
  spoofed snapshot labels. Legacy untagged input remains untagged.
- Dispatcher lifecycle/questions read the retained execution anchor. Question
  controls keep the exact execution/question IDs; ordinary display hides UUIDs.
- Native in-flight tool restart recovery retains the persisted label. Existing
  `hashtag-output.test.ts` covers outbox retry/reload, single prefix and late host
  result delivery. This proves transport lineage, not model comprehension.

Source boundaries:

- `src/harness.ts`: `ensureSession`/runtime open are keyed by conversation and
  explicit session selection; `runTurn` calls `memory.recall(s.key, input.text)`.
  Parsing labels does not replace either identity. `/resume` selects a retained
  session using the existing conversation-scoped navigation checks.
- Canonical plugins `src/matrix-channel.ts`: incoming key is
  `matrix:${roomId}${thread ? ':' + thread : ''}`. Existing Matrix threads are
  already separate Harness conversations; hashtag text does not affect this key.
- Canonical plugins `src/memory-service.ts`: recall, capture and pending records
  use `sessionKey`. Tags do not introduce a new memory namespace.
- `src/hashtags.ts` and `docs/hashtags.md`: lookup indexes conversation/session/
  transcript-message references. Labels use assignment/execution provenance, not
  the currently displayed conversation's newest input.
- Continuations retain task identity, original mandate and deadline. Worker
  lineage uses exact execution ID and current token; parent labels cannot turn
  worker text into operator authority. None of these permissions derives from a
  tag, nor can identical labels join separate permissions.

## Existing smallest alternative

Use **separate existing Matrix threads** for topics that need separate prompt
history; use `/hashtags #slug` and its exact `/resume <session-id>` reference to
return to retained history. Resuming is navigation, not a clean-history guarantee.
`/new` creates fresh runtime history within the existing conversation; it is not
an independent memory or authorization profile.

Required mechanical invariants for genuine isolation:

1. Different topic threads yield different conversation keys and runtime sessions.
2. History lookup/resume must stay within its existing conversation boundary.
3. Memory providers must actually enforce the supplied conversation scope; the
   label feature does not strengthen or audit external provider isolation.
4. Queues, continuations and late worker events retain their original task anchor;
   no global 'current tag' and no retagging outstanding work.
5. Permissions remain independently bound to channel/operator/task authority.
   A new label or thread grants no additional rights.

Within one thread/session, mixed topics remain mixed history even when each
message is correctly labeled. Textual instructions such as 'ignore the other
subject' are semantics, not isolation. A last-good topic snapshot/rollback or
separate memory profile is **not** supplied by hashtags. Existing persisted
transcripts and execution records are evidence, not automatic topic checkpoints.

## Delivery evidence boundary

Tests establish source-level behavior. A source commit, successful build or image
is not proof that an installed Matrix activity row has changed. Record reviewed
PRs, immutable plugin pin, image digest, desired/live state and health separately
in the task delivery result. Until that chain is verified, the live status gap
remains open.
