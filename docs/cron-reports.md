<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cron audiences and retained follow-through

Retention, report context, analysis and proposal planning are supplied by the
`cronReportPlugin` in the independently versioned [hayate-agent/plugins](https://github.com/hayate-agent/plugins) repository.
Core provides settlement/delivery hooks, `ReportProcessingRegistry` and host-owned
dispatch authority, not a concrete archive or analyzer. Trusted plugins can register
another implementation through `api.registerReportProcessing(name, implementation)`;
select it at startup with `reportProcessing: <name>` (default `cron`). The interface
covers `record(input, output)`, `context(input)`, `tick()` and `stop()`.
Implementations must make recording idempotent and stop ongoing processing during
cleanup. Registration is rejected in tool-only and runtime-extension modules.
There is no universal hot-swap claim for held processor instances.

Legacy jobs without `audience` keep their existing behavior. Explicit jobs select:

```yaml
jobs:
  - name: service-report
    schedule: '0 8 * * *'
    audience: user
    deliver: 'matrix:!room:example.org'
    prompt: 'Inspect service health and report findings. Do not change services.'
    follow_up:
      authorization: 'Investigate reported service problems using read-only logs. Never deploy or change configuration.'
      max_tasks: 2
  - name: internal-review
    schedule: '0 */6 * * *'
    audience: agent
    prompt: 'Review authorized outstanding work. Do not send a user report.'
```

`audience: agent` suppresses user delivery, including the default home address.
`audience: user` requires a resolved destination. `no_agent: true` can be combined
with user reports: the script output is retained and later analyzed without a
report-generation model prompt. Agent-only jobs require agent processing.

Explicit runs enter the durable Harness inbox. Their final output is stored in
the execution settlement and archived in `<home>/cron/reports/` before the outbox
can deliver it. An archive failure holds delivery and retries the settled result,
not the model/tool execution. This guarantee relies on the production execution
ledger and durable state saving; arbitrary tool effects remain at-least-once around
crashes before settlement. Empty/NO_REPLY output creates no report.

A separate, tool-less analysis runs at maintenance intervals, with bounded input,
structured output, a 30-second cancellation deadline and at most three proposals.
Analysis failure does not prevent user delivery; the retained report can retry.
Shutdown cancels analysis and waits for the active processor. A backend ignoring
cancellation is not started again in parallel. Stored reports remain available
until explicitly removed; archive retention/compaction is not automatic.

Recent user reports are injected as bounded untrusted evidence into subsequent
channel prompts with the exact destination and thread. Other destinations and
internal reports are excluded. This provides awareness without claiming that
reports became independently verified memory or instructions.

Without `follow_up`, proposals require approval and no work is dispatched.
`follow_up.authorization` is a separately configured operator mandate, not text
extracted from a report. `max_tasks` is 1–3. The analyzer proposes relevance; it
cannot expand that mandate. Workers receive the original scope as their trusted
mandate and proposals as untrusted data; existing tool guards, approvals and review
still apply. Semantic scope checking is an agent judgment, not a deterministic
sandbox. Use restricted tools and approvals for hard enforcement of side effects.

Dispatch uses durable run/action IDs. A crash between dispatcher submission and
report bookkeeping reuses the existing ledger execution. Disabled/unavailable
dispatcher leaves authorized work pending instead of executing it inline. Each
action has an isolated internal `cron-followup:` parent; results cannot fall back
to the home channel. Paused/blocked worker questions remain inspectable through
`/dispatch`; they are not silently converted into new permissions or user reports.

Configuration is trusted installation input. Report files and metadata must not
be exposed to untrusted writers. ESM plugins retain their existing process-level
privileges. This feature does not provide arbitrary exactly-once external effects
or automatic cross-conversation access.
