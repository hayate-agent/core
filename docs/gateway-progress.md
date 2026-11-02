# Gateway progress and status reactions

Configure global defaults and optional per-gateway overrides in hayate-agent.yaml:

```yaml
gateways:
  progress: reduced
  statusReactions: true
  overrides:
    matrix:
      progress: full
    slack:
      statusReactions: false
    telegram:
      progress: off
```

Runtime changes (admin-only, persisted in `settings.local.yaml`, no restart):

- `/gateway progress reduced` (or `off` / `full`)
- `/gateway reactions on` (or `off`)
- `/gateway status`

Local settings override installation defaults. Partial updates to local gateway
settings preserve existing overrides for other channels and fields; empty override
objects do not reset existing values. Existing per-channel and explicit
Matrix environment overrides retain precedence. Active progress collectors adopt
changed progress mode on the next turn; reaction settings apply immediately.

Defaults: progress off, statusReactions false. Each omitted override field
inherits the global setting. Explicit off/false disables an inherited setting.
Names are channel names, including plugin gateways. This does not install an
adapter or add capabilities it does not implement. The Harness applies the
resolved policy through optional configureGateway before channel startup;
plugins can implement this hook with turnEvent/turnStatus. Existing TUI/API
streaming is unchanged by gateway notification policy.

Matrix environment variables are optional explicit overrides. Precedence:
environment > per-gateway YAML > global YAML > defaults.
If unset, they do not mask inherited YAML settings.

- MATRIX_PROGRESS=off: typing indicator only.
- MATRIX_PROGRESS=reduced: tool starts/ends without arguments/results; active tools
  emit a truthful elapsed-time heartbeat every 15 seconds, including long reviews.
- MATRIX_PROGRESS=full: tool starts/ends, bounded arguments/results. No private
  model reasoning is exported. Final assistant text uses the normal durable reply.
- MATRIX_STATUS_REACTIONS=true: 📥 after durable receipt (including queued messages), 👀 at turn start; ✅ when processing completes,
  ❌ on failure, ⏹️ on cancellation. Default false. For batched inputs each original
  message is annotated. Obsolete receipt/start reactions are redacted when the
  status advances, so only the terminal status remains. Completion does not assert
  successful delivery of replies. Reaction cleanup is best effort and requires the
  homeserver to allow redacting the bot's own events.

Full mode may disclose command arguments, paths and tool results to room members.
Enable only in rooms appropriate for those contents. Progress is best effort,
not persisted or replayed; delivery failures do not fail the agent turn. Notices
are batched for 1.5 seconds, at most 50 entries per turn and 8000 characters per
batch (2000 per detail). If a progress sender is slow, only one in-flight batch
and the latest pending batch are retained; intermediate progress may be dropped.
Final replies retain durable outbox semantics.

Progress messages carry transport-neutral `SendMeta.presentation: "progress"`.
Their text is plain text, not preformatted Matrix/Slack/Telegram markup. Matrix
renders it as escaped italic HTML (`<em>`), keeping a plain-text fallback; ordinary
replies retain Markdown rendering. Adapters may translate this intent into their
own native formatting or fall back to plain text. No Slack/Telegram adapters are
implemented by this presentation change. Byte-budget chunking includes formatting.

Channel.turnEvent and Channel.turnStatus are optional transport-neutral hooks;
GatewayProgress can be reused by future Slack and other adapters. There is no
Slack implementation in this change. Status reactions use deterministic Matrix
transaction IDs to avoid duplicate annotations on retried processing.
