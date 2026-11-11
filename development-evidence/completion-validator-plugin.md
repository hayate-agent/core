# Completion validator extraction evidence

## Scope and bases

Core base: 63c2fa102191020466f2ffac6781d3d396da603a.
Plugin base: 999e01167aec66d74e8a1ff240d1b8841ae3572e.
Published plugin implementation: 0df11da76fc8e5f15617fa09c7450e7f2ced5458,
https://git.vanillacore.net/harness/plugins/pulls/91.
Worktrees: /tmp/shikamaru-validator-core and /tmp/shikamaru-validator-plugins.
No edits to the original dirty checkouts or the concurrent compaction worktree.
No deployment, live configuration change or service restart in this step.

## Implementation

Core validator.ts defines API v1 provider requests and per-host registry with
validated names/versions, duplicates rejected, explicit selection/disable and no
implicit fallback. PluginAPI exposes startup-only registerValidatorProvider.
completion-check.ts keeps caller compatibility, input budgeting and host permission/
checkpoint checks, delegating assessment orchestration and interpretation to the
plugin. CLI task/nightly and DispatcherRuntime delegated-step paths share the
same host registry. completionCheck.provider selects a name or false; legacy-llm
is the default. Existing completionStrategy remains the prompt selection API.

Plugin completion-validator-plugin.ts contains the legacy provider, bounded
assessment orchestration and existing continuation interpretation. The LLM judge
uses the supplied backend/model/prompt; no TypeSafe code or endpoint policy is
added. The core AssessmentBackend interface is unchanged. Persisted continuation
and sequential assessment checkpoint shapes are unchanged.

## Verification

With Node's inherited LD_LIBRARY_PATH cleared and umask 022:

- npm run typecheck: passed.
- npm test (including normal prebuild/materialization from the published plugin
  revision): 1898 tests, 1897 passed, zero failed, one skipped.
- Plugin source tests: 4 passed, zero failed.
- Integration subset after adding dedicated step-provider tests: 77 passed.

New tests cover API/version/name/duplicate validation, real plugin registration,
selection/disable/missing/error, redacted diagnostics, legacy task/step result
parity and JSON persistence, API/authorization/abort/deadline/checkpoint fences,
malformed/inconclusive answers, noncooperative provider timeout, selected-provider
use by real sequential execution, disabled-provider evidence retention and actual
worker-failure precedence. The existing full suite additionally exercises task
stop/deadline, required approvals, completion budgets, worker/parent state,
context preparation and retained evidence/recovery.

Initial full run had environment failures: inherited umask 077 prevented an
unsafe-directory fixture, and npm ci --ignore-scripts omitted Matrix native
binding. The native binary was copied from the already-installed matching
local dependency into this worktree only; umask was normalized. Subsequent normal
npm typecheck/test runs above passed. No test or protection was disabled.

## Diff fences

No changes in dispatcher-config.ts, model-roles.ts, dispatcher-step-prompt.ts,
completion-budget.ts or AssessmentBackend. Dispatcher runtime changes are only
passing the registry to the existing sequential strategy and completion call.
No routing, planner/model policy, core default prompts or authorization expansion.
Bundled completion-prompt.ts is unchanged. The plugin pin changes only revision
and adds the new implementation hash.
