# Gateway progress and status reactions

Configure global defaults and optional per-gateway overrides in harness.yaml:

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
- MATRIX_PROGRESS=reduced: one brief activity notice per tool name per turn.
- MATRIX_PROGRESS=full: tool starts/ends, bounded arguments/results. No private
  model reasoning is exported. Final assistant text uses the normal durable reply.
- MATRIX_STATUS_REACTIONS=true: 👀 at turn start; ✅ when processing completes,
  ❌ on failure, ⏹️ on cancellation. Default false. For batched inputs each original
  message is annotated. Completion does not assert successful delivery of replies.

Full mode may disclose command arguments, paths and tool results to room members.
Enable only in rooms appropriate for those contents. Progress is best effort,
not persisted or replayed; delivery failures do not fail the agent turn. Notices
are batched for 1.5 seconds, at most 50 entries per turn and 8000 characters per
batch (2000 per detail). Final replies retain durable outbox semantics.

Channel.turnEvent and Channel.turnStatus are optional transport-neutral hooks;
GatewayProgress can be reused by future Slack and other adapters. There is no
Slack implementation in this change. Status reactions use deterministic Matrix
transaction IDs to avoid duplicate annotations on retried processing.
