# Opt-in model roles

`modelRoles` is an optional object in installation settings or the existing durable
local settings overlay. Absence/`enabled: false` preserves historical routing.
The object has only `enabled` and optional `roles`; the five allowed roles are
`dispatcher`, `simple`, `medium`, `high`, `reviewer`. Each pair accepts a full
`provider/model` reference and optional thinking level (`off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`). This does not grant tools, authority or budget.

Authenticated channel administrators (or the attached local console) can use:

```
/model-roles show
/model-roles set dispatcher provider/model medium
/model-roles set simple provider/model low
/model-roles enable
/model-roles disable
/model-roles reset simple
/model-roles reset
```

Empty administrator lists do not make this command public. Host, scheduled and
API-originated input cannot use it. Changes are durably saved by SettingsService
and apply at the next selection, not during an active worker turn. File reload
uses the same store and validation. No separate roles file is created.

Direct dispatcher routing keeps existing first-match `dispatcher.rules` priority,
including catch-all rules. Only an unmatched, opted-in new turn makes a single
bounded tool-free ephemeral assessment of task-data JSON. Its closed response
schema is `{"complexity":"simple"|"medium"|"high","rationale"?:string}`;
rationale is limited to 500 characters. Invalid responses, timeout, abort and
technical failures never create a second assessment or replay work. The selected
worker pair is saved in the existing unsafe intent before Harness acceptance.
Recovery retains that pair and never reclassifies uncertain work.

Role preflight checks local runtime model availability and supported thinking
without prompting a provider. Missing capability/model or unsupported thinking
falls back to the consumer's entire existing default pair. Availability is not
proof of successful live authentication. There is no initial-429 replay.

The reviewer profile selects models only. CodeReview still uses independent
review workers/subagents/worktree transport, its JSON verdict and durable budget;
explicit legacy review model/thinking fields take precedence. Supervisor still
uses completion assessment, authority/admission and whole-prompt budget gates;
its default thinking remains low, independent of CodeReview's medium default.
Neither reviewer selection affects topic labels or context maintenance.

Source delivery is not activation. No provider configuration, credentials,
runtime settings, images or deployment are changed by installing this source.
