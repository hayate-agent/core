# Built-in changeset review

The review plugin ships with the Harness and is enabled by default. No local ESM
module or PI extension installation is required. The Harness owns persisted state,
budget and lifecycle integration; the bundled plugin exposes `/review status`,
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
P2/P3 are retained and nonblocking. The working agent must critically assess every
finding, using `plugin_review` action `assess`, the latest round's fingerprint and
an assessment for every finding: `confirmed`, `false-positive` or `uncertain`, each
with concrete evidence. Confirmed defects should be fixed. Rebuttals are supplied
to the next reviewer; they are not unilateral permission to bypass a P0/P1 finding.
A persistent disagreement is escalated rather than automatically believed by either
model. The final exhausted round is escalated with its findings for operator review.

Budget reservations are durable before external calls. Edits, session switches and
process restarts do not reset an unresolved task. Reviewer failures consume budget.
A successful review is bound to the exact changeset fingerprint; a concurrent edit
cannot inherit it. A subsequent changed task after a successful review gets a fresh
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
