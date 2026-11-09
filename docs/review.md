# Bundled or selected changeset review

`reviewEngine: plugins/my-engine.mjs` selects a trusted local startup engine instead
of the bundled implementation. Paths resolve against Harness home. The module
exports default `{apiVersion:1, modelTools:['plugin_custom_review'], create(context)}`.
The context supplies home/cwd, compatibility review config, a tool-free assessment
backend, notification and origin callbacks. Return `{policies, plugins, required,
instructions}`; policies and command/tool plugin modules are selected together.
Required identities must be supplied by the selected policies. `modelTools` names
are included under an explicit nonempty tool selection; `tools: []` stays empty.
`review.enabled: false` disables selection entirely, including local import.
Invalid/missing engines fail startup, never silently fall back to a different gate.

This is trusted in-process code, not a sandbox. `create` must prepare only; register
resource cleanup through returned plugin lifecycle hooks. Selection is startup-only,
not an atomic hot-replacement of live tools and policy state. Existing policy-only
runtime overrides remain narrower and do not replace the selected tool service.
Custom implementations own compatibility with existing review ledgers; selection
does not migrate, erase or grant permission to reset them. The bundled default
continues using the unchanged ledger and budgets. Review configuration/model
compatibility still lives in the host; this is not universal settings extraction.

The review plugin ships with the Harness and is **disabled by default**. No
local, publication or merge gate is enabled unless the operator explicitly configures
it. Enabling the plugin alone provides advisory review; `mandatory` defaults to
`{local: false, publish: false, merge: false}`. The configuration below is an
**opt-in example**, not a starter-profile default. No local ESM
module or PI extension installation is required. The source plugin repository owns
the engine, ledger implementation, budget, lifecycle/guards and default composition;
Core supplies configuration compatibility, generic policy execution and runtime
assessment plumbing. The immutable pin is built into the image, not hot-unloaded.
Existing ledger paths/format/history/grants remain unchanged. The bundled plugin exposes `/review status`,
`/review run`, and the `plugin_review` model tool. Commands require administrator
access. With an explicit nonempty `tools` list the Harness includes `plugin_review`;
`tools: []` still means no model-visible tools.

```yaml
review:
  enabled: true
  shellGuard: false # opt-in defense in depth for common publish/merge commands
  scope:
    mode: risk # all = review every nonempty changeset
    nonBlockingPaths: ['docs/**', '**/*.md', '**/*.txt']
    requiredPaths: ['.github/**', '.gitlab-ci.yml', 'deploy/**', '**/SKILL.md', '**/AGENTS.md', '**/SOUL.md']
  model: your-provider/your-review-model # omitted: configured runtime model
  thinking: medium
  maxTurns: 3
  mandatory:
    local: true
    publish: true
    merge: true
  baseRef: origin/main # recommended for branch/PR work
```

Model availability and authentication must actually be configured. There is no
hardcoded claim that a particular model exists. An unavailable model, failed call
or invalid response grants no approval and consumes one reserved review round.
Disabling `review.enabled` disables the plugin and gates. Configuration changes
require restart. `maxTurns` accepts integers from 1 to 20.

## Risk-based obligation

Review availability and review obligation are separate. Default scope mode `risk`
skips automatic review for documentation/text-only changes. Required path patterns
win over nonblocking patterns; all unknown paths (including application code,
dependencies and ordinary configuration) require review. Agent instruction files
such as SKILL.md remain required even though they are Markdown. Customize both
pattern lists or use `mode: all`. Classification uses Git paths, not model claims.
An explicit `/review run` still reviews documentation if requested. `mandatory`
selects which lifecycle gates apply; `shellGuard` independently opts into shell
interception and defaults to false. No remote branch protection is installed.

## Dedicated execution routing

The bundled review plugin requires a dedicated execution capability from the host.
It never uses the working agent's general assessment backend as a fallback:

1. Dispatcher enabled: a dedicated read-only review worker.
2. Dispatcher disabled: a dedicated read-only review subagent.
3. Primary execution unavailable/failed: an explicit fresh-session review handover
   with a detached local candidate worktree. Cancellation never starts a fallback.

Routing model/thinking for the dedicated review worker follows the dispatcher rules
(see "Dispatcher model routing rules" in configuration.md); rules are validated on
startup and through `settings.local.yaml` overlays, where `dispatcher.rules` and
`reasoningEffortNoneModels` are live-editable and apply at the next worker dispatch
or request boundary.

The host uses a separate Dispatcher execution transport for review, not the ordinary
working-tool strategy or its capacity queue. Review submissions may carry the full
changeset prompt: task inputs are validated up to 1 MiB at submission (dispatcher.md
"Submission and control"), which covers the 512 KiB changeset limit after JSON
escaping. The dedicated review worker deadline is 30 minutes (1800000 ms): local
flash providers show multi-minute latency variance for large review prompts, and
shorter deadlines cancelled real rounds mid-computation; the deadline stays
fail-closed for hung workers. This avoids a waiting parent consuming
all worker slots and triggering review recursion. `review-executions.json` is an
execution ledger, not a new review budget. Existing review rounds, findings and
approval fingerprints remain owned by the plugin. Cancelled primary execution is
drained before a fallback starts; a provider ignoring cancellation may therefore
hold the safety fence rather than permit overlapping reviews.

Review children use ephemeral runtime sessions with tools/extensions/project context
disabled. Dedicated subagent records in `review-subagents/` retain parent, fingerprint,
model choice, outcome and result. On startup, stale running children are marked
interrupted, never automatically replayed. Interrupted dispatcher review executions
are cancelled before scheduler recovery. A new attempt must still pass the original
review ledger budget. Worker/subagent/fallback time limits request cancellation
rather than pretending to forcibly terminate an unresponsive provider.

The worktree snapshot contains tracked changes and bounded regular untracked files;
unsafe/nonregular paths fail closed. It is supplied in an explicit handover together
with the immutable review prompt. The tool-free runtime is **not rebound to that
filesystem cwd** and cannot browse it: the actual review input is the captured diff.
This is not a general working-agent worktree or a claim of sandboxed filesystem
execution. Final candidate revalidation still belongs to the review service.

Host capability instructions are generated per working turn, independently of
optional skill metadata. Configured, ready, registered, exposed and session-allowed
are separate facts; none is proof of provider authentication or extra authority.

For local plugin development, use
`node scripts/test-local-review-plugins.mjs <plugin-source> [test-files...]`.
It creates a temporary hash lock for the normal materializer and does not change
`plugins.lock.json`. Ordinary npm scripts still use the production pin. Local
materialization and a successful build do not activate a deployed installation.

## Changeset and scope

The Harness captures a base before the working turn. An explicit `baseRef` uses
its merge-base with HEAD. Without it, the upstream merge-base is used if available;
otherwise the current HEAD is used. Set `baseRef` explicitly for already committed
branch changes without an upstream: the default cannot infer a PR target.

Review input is the complete tracked diff from this fixed base to the working tree,
plus untracked, non-ignored regular text files. It does not include the entire
repository or give the reviewer tools to explore it. Renames and deletions are
represented by Git's diff. Inputs exceeding 512 KiB fail closed, not silently
truncate. Untracked binary/non-regular files require operator intervention. Place
secrets outside versioned/untracked changesets: the diff is transmitted to the
configured model provider. Do not put the Harness home inside the reviewed repository.

The reviewer is an ephemeral, tool-free PI session with no project context files,
skills, external extensions or persisted conversation. It emits JSON findings with
stable IDs, P0–P3 severity, file, line, title and concrete evidence. The configured
model may be the same as the working model if no separate reviewer is configured.

## Critical assessment and budget

After code work the local lifecycle gate invokes review. P0/P1 are blocking;
P2/P3 are retained and nonblocking. Reviewer findings are claims, not final authority.
The working agent must check P0/P1 against code, failure paths and, where needed,
reproductions or tests. Use `plugin_review` action `assess` with the latest round's
fingerprint and `confirmed`, `false-positive` or `uncertain`, each with concrete
evidence. Confirmed and uncertain P0/P1 remain blocking. An evidence-backed
false-positive assessment resolves that finding; when no blockers remain, the
exact reviewed fingerprint is approved without demanding another reviewer round.
This also works after budget exhaustion. It cannot approve changed bytes; confirmed
fixes require review of the changed candidate. P2/P3 assessments are optional.
Findings and counter-evidence remain in the ledger for audit.

An existing escalation does not decorate subsequent chat replies or trigger another
review. Exhaustion is notified separately on the transition into escalation, not on
repeated `run` calls or repeated escalation requests. Explicit status remains
available, and publish/merge guards still enforce the unresolved review. This keeps
conversation output separate from task review state without approving blocked code.

Budget reservations are durable before external calls. Edits, session switches and
process restarts do not reset an unresolved task. Reviewer failures consume budget.
A successful review is bound to the exact changeset fingerprint; a concurrent edit
cannot inherit it. At the next pre-turn boundary, a passed task may be archived
when the worktree (including untracked files) is clean, HEAD exactly equals the
configured remote-tracking baseRef (or remote-tracking upstream), and the old base is its ancestor. This
records an accepted upstream task boundary, not review approval of historical
commits: the new state is pending with no approved fingerprint, based at HEAD.
The old base, fingerprint, rounds and boundary ref/HEAD remain in history. Missing
upstream, local-only commits, dirty work and unresolved/escalated tasks cannot
rotate the base or reset budget. New working-turn edits remain mandatory-review
changes even when old upstream history exceeded the unchanged 512 KiB limit.
A subsequent changed task after a successful review gets a fresh
budget. State is serialized per repository under `<home>/reviews/<root-hash>.json`.
Corrupt state fails closed. There is intentionally no agent-accessible budget reset
or operator override command in this first version. An operator must inspect and
archive/reset the state file while the Harness is stopped to authorize a new attempt.

Exhaustion marks the state escalated and posts a durable operator notice to the
original request's channel and thread. This address and originating session key are
stored with the review and survive restarts/background continuation. Later sessions
do not replace an unresolved task's origin. If no origin exists, the configured
Harness home address is used, then the session reply address; notices also log locally.
An escalation is not approval and does not authorize a merge or rollout.

## Local reasoning-only responses

A review response with no final text is not a verdict. The runtime reviewer makes
one bounded retry with thinking `off` when the first response was empty and the
requested thinking level was not already `off`. JSON validation and the gate's
round budget remain enforced; a second empty/invalid response still fails.

Some local OpenAI-compatible servers require `reasoning_effort: "none"` rather
than their ordinary thinking switch. Opt in only models verified to accept that
parameter — through the Harness process environment or, preferred, the
`reasoningEffortNoneModels` key in `hayate-agent.yaml` (the process environment
variable keeps working and all lists are merged; a `settings.local.yaml` overlay
with the same key is live-editable and applies at the next request boundary, see
configuration.md "Reasoning effort none opt-in"):

```sh
HARNESS_REASONING_EFFORT_NONE_MODELS='homelab/deepseek-v4-flash,homelab/glm-5.3-flash'
```

```yaml
# hayate-agent.yaml
reasoningEffortNoneModels:
  - homelab/deepseek-v4-flash
  - homelab/glm-5.3-flash
```

Entries are exact `provider/model-id` references from the installation, not display
names. For opted-in `openai-completions` models, an explicit per-turn thinking
`off` adds `samplingParamsByThinkingLevel.off.reasoning_effort = "none"` to a
copy of the selected model and restores the original selection afterward. No
root-owned `models.json` or SDK files are edited. Other models remain unchanged;
models such as o3-mini must not be opted in without verified support. This is a
process-level setting requiring restart. Existing model-specific SDK sampling
configuration is another supported route.

Fixing the provider does not reset an escalated review budget. Operator resolution
of the existing escalation is still required; do not delete review state or
start another session to evade it.

## Administrative budget extensions (requires matching plugin)

After explicit operator authorization an administrator can use the matching review
plugin command, not the model tool:

```text
/review extend <grant-id> <rounds> <base-commit> <candidate-fingerprint> <operator-reason>
```

The service requires an exhausted, escalated review on that exact base and current
candidate. It appends actor, reason, timestamp, count, candidate and prior round index
to `budgetGrants`. Rounds, assessments and history remain intact; no approval is
created. Identical grant IDs are idempotent even after consumption; conflicting reuse
is rejected. Grants allow 1–20 rounds only for the named candidate, not subsequent
changes or tasks. Completed-task history retains the audit records. Administrators
must verify the operator's scope: a fingerprint binds bytes, not their meaning.

Older installed plugins do not expose this command. Building does not activate it.
Use the owning Harness's administrator command after reviewed activation; never write
the live ledger from a second process. The model tool remains `status | run | assess`.

## Enforcement and limits

The local gate runs before final completion of a code-changing working turn,
returning findings to the same working session for assessment/fixes. Reviewer
cancellation is connected to turn cancellation and shutdown. The bundled plugin can
also be invoked explicitly when automatic local review is disabled.

When `review.shellGuard: true`, the PI tool-call hook checks standard `git push`, `git merge`/`rebase`, `gh pr
create`/`merge` and `glab mr create`/`merge` shell invocations against the current
approval. **This is defense in depth, not a general shell security boundary.**
Arbitrary scripts, aliases, custom tools, different working directories and compound
commands can bypass a textual command check. Enforce non-bypassable remote merge
policy with branch protection and CI; this release does not claim to intercept all
possible publication paths or install a required remote CI check automatically.
Successful review never replaces tests, human approval, authorization or GitOps.

Repositories without an initial commit currently cannot establish a review base;
with default-enabled review this blocks working turns there. This is a known P2
limitation, not a successful review of initial-repository support.

The lifecycle gate is workspace-wide. Other dirty work in the same repository is
included; use isolated worktrees for independent concurrent tasks. Cross-process
review ownership is not implemented beyond the Harness's existing home lock.
Unit tests use deterministic reviewer doubles; they do not prove model quality.
The same `runtimeReviewer` backend used in production can also be exercised against
a configured live provider in an isolated Harness home.
