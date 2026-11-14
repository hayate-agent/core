# Core operator orders and optional plans

The Core task book is stored in the existing `executions.json` transaction ledger.
It is active in the production CLI even when Dispatcher is disabled. It is not a
Dispatcher strategy or a new background scheduler. SDK embedders explicitly opt
into `HarnessOptions.taskLifecycle` and supply the existing ExecutionStore.

## Authority versus technical completion

Each order has a stable agent-wide ID, a generation and revision:

- `operatorStatus: open | done | unresolved` is operator disposition.
- `technical.state` describes the observed result separately.
- The immutable original request and authenticated clarifications remain sources.

`done` with a technically blocked or incomplete result is valid. A validator,
restart, old session, wait timer or late child outcome cannot override it. Explicit
reopening creates a new generation; saved old admissions retain the old generation
and remain unusable. Task state is not stored solely in model/session history.

## Operator commands

```text
/orders
/orders show <exact-order-id>
/orders done <exact-order-id>
/orders reopen <exact-order-id>
```

These commands use the existing authenticated admin command path. `/tasks` retains
its historical `/agents` alias; it is not silently repurposed. Inspection shows
operator and technical status separately. Reopening creates a technical projection
in the requesting conversation; no old child effect is replayed or declared undone.

`plugin_tasks` is the model-facing Core capability. It lists/shows orders, proposes
plans, and can request close/reopen/clarify from current authentic operator input.
Natural-language lifecycle changes require a bounded, independent scope/intention
check, exact task/input revision revalidation, and real operator provenance.
A validator's suggestion or quoted historical instruction is not such provenance.
Commands remain usable when model review is unavailable. Model-facing cross-topic
inspection is restricted to the current conversation unless the host authenticates
the operator for broader inspection. Core storage itself remains agent-wide.

## Optional plan and presentation

Simple tasks do not need a plan. For multi-step work, Main can propose a plan using
`plugin_tasks` with `action: propose-plan`. Stable todo IDs include source IDs,
kind, state and supporting outcomes. The supported kinds include memory research,
skill research, source research, internet research, work, verification, skill
check, skill change and delivery.

Planned work must account for memory/skill/source/internet research and the final
skill check. An irrelevant or forbidden research category can be `omitted` with
an explicit reason. `done` and `omitted` require an outcome, not just a tool call.
A negative search or a grounded "no skill change required" can finish the relevant
step. Further skill changes become scoped todos, not an endless optimization loop.

Plan updates are proposals, not direct ledger writes. They are independently
checked against the request, clarifications and available tool/worker outcomes.
Successful turn settlement atomically commits the plan, technical outcome and
ordinary durable outbox entries. Main displays the committed checklist in its
normal thread. Failed/cancelled turns cannot adopt pending plan proposals.
Unchanged lists are not emitted again. A new outcome cannot silently delete or
reopen an already settled todo. The original operator request still bounds scope.

The Core completion context for these orders includes the scoped original,
clarifications, plan, task-local retained observations and worker outcomes. It no
longer needs every old task or the conversation's recent unrelated topics merely
to judge one order. Existing prompt byte limits remain binding.

## Inactivity policy

No timeout is invented by a model or hardcoded as a default. Operators may set:

```yaml
taskLifecycle:
  inactivityMs: 172800000 # example only: 48 hours
```

The minimum is 60,000 ms. Only genuine operator lifecycle input updates the order's
operator-activity clock; worker/validator outcomes do not. Explicit schedule-created
orders are exempt from this chat-inactivity disposition. A close due to inactivity
preserves technical evidence and records its separate reason; it does not claim
successful work. Detailed recurring-series generation policy remains separate
from individual schedule occurrences.

## Upgrade boundary

Historical session tasks without a Core binding are imported as `unresolved`, not
silently presumed still wanted and not silently marked technically successful.
Existing child ancestry is bound to those held orders. Operator inspection and an
explicit reopen decide which work should continue. Existing generation-bound
orders retain their state after restart/session replacement. Unbound legacy worker
claims fail closed in the production execution store.

This deliberately changes historical auto-resume behavior. Review the held order
inventory during upgrade; do not automatically reopen all of it. No live task
migration or rollout is performed by source tests.

## Current boundaries

This is a first implementation, not a claim that all semantic bookkeeping is
solved. Natural-language association uses an advisory model and explicit Core
revision/provenance gates; ambiguous association is rejected. The current tools
allow explicit operator-backed clarification/attachment, rather than guessing that
all similarly worded requests are the same topic. There is not yet an external
shared package consumed by Pi. Automatic validator-authored plan patches and
registered cron-series reopening contracts require further integration; validators
currently receive the plan and Main submits outcome-bound patches.
