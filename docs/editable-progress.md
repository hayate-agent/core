<!-- SPDX-License-Identifier: Apache-2.0 -->

# Editable progress replies

Channels may opt into `Channel.editableProgress = true`. Plugin channels expose
the same optional flag. The host persists `Inbound.progressId` before starting a
replayable turn when gateway progress is enabled. Progress and the final reply
share this transport-neutral logical message ID (`SendMeta.progressId`). It is
not a provider-specific event ID and must be resolved idempotently by the adapter.
The final reference is persisted in the normal durable outbox.

Matrix resolves the logical ID through a deterministic seed transaction, whose
response contains the original Matrix event ID. Repeating the transaction after a
lost response or restart recovers that reference within the homeserver's transaction
idempotency guarantees. Seed content is invariant. Status updates use `m.replace`
with escaped italic `m.new_content`; final replacement uses ordinary Markdown.
Thread relations are retained inside new content. The original event is checked
for redaction/unavailability before final editing; 403/404 falls back to a normal
message. This is not end-to-end exactly-once: homeserver transaction retention and
redaction races can still produce duplicates or an invisible edit. A permanent
room permission failure cannot be repaired by editing and remains an outbox failure.

Progress retains the existing 1.5s batching and bounded telemetry queue. On turn
completion pending progress is flushed before final delivery; Matrix drains queued
telemetry before a final edit, preventing older progress from overwriting the answer.
Long answers edit the first chunk and send the remaining chunks normally with
stable delivery IDs. Errors/cancellation/silent completion receive terminal text
instead of leaving the status permanently running. Progress-off and channels
without the capability retain ordinary delivery. Replayed turns retain the same
logical ID; explicit questions/intermediate assistant messages are not edited.

Progress itself remains best effort, not a durable event stream. A pod killed before
final turn completion can leave a status until replay finishes. No new Telegram or
Slack adapter is included; their adapters must implement logical-ID resolution,
ordered edits, final replacement and normal-message fallback before opting in.
