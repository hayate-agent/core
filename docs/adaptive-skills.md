# Adaptive local skill recipes (opt-in)

Installation configuration (`harness.yaml`):

```yaml
skills:
  adaptive: true
```

Default: **disabled**. This is not a model-writable local setting. Enabling it is
an operator policy decision: model-generated reusable text may be saved and
subsequently loaded as **untrusted reference data**. No live configuration is
changed by installing the code. Restart the Harness after changing installation
configuration; no restart is needed between individual recipe revisions.

## Supported lifecycle

1. At working-run start, match the bounded user prompt against the existing
   catalog's names/descriptions, using case-insensitive keywords (as in
   `plugin_skill_search`). Read only relevant bodies. References are delivered
   through PI's supported `before_agent_start.message`, not its system prompt.
   Catalog bodies larger than 8192 bytes are excluded from automatic loading,
   not treated as unsafe references. A bounded host diagnostic reports actual bytes
   and the limit (once per file, at most three notices per working run), without
   copying the body into context or blocking the turn/action. PI projects these as
   one host-owned system-context message before model requests, including after a
   tool-time match; they are not skill references or persisted transcript entries.
   No paths, folder labels or file contents are included. The model can report the
   issue and suggest a short SKILL.md with separate reference files, or use metadata
   discovery and explicit `read` with offset/limit for bounded sections under usual
   tool policy. No automatic read, rewrite or split is performed; reading is not
   execution. Unsafe aliases and non-files still fail closed. The fixed autoload
   limit and the separate managed-recipe validation limits are unchanged; no new
   configuration or local-settings override is introduced.
2. Before a native/plugin action, match its name and bounded input. PI's
   `tool_call` result cannot inject context. A new relevant reference therefore
   blocks that attempt with the reference as data; the model can reconsider and
   retry. Identical content is not blocked twice in that run. Retrying does not
   bypass tool allowlists, review, guards or approvals.
3. Successful native `read/bash/edit/write/grep/find/ls` results receive a host
   receipt. Failed/blocked actions and arbitrary plugin/web results do not.
   No extra inference call is made: the working model decides whether the
   observed work produced a genuinely reusable procedure, then calls
   `plugin_skill_learn`. This is not a mandatory every-turn generation step.
4. The host validates current-run receipts, schema, budget, revision, storage
   ownership and installed-name collisions. It atomically saves a SKILL.md
   under `HOME/adaptive-skills/<sha256(cwd + session-key)>/<name>/SKILL.md`.
   Provenance stores only the schema, opaque owner scope and native tool names;
   it never copies tool output, arguments, user history or credentials.
5. The save result includes the validated new body/revision, immediately making
   it available in tool-result context. Future matching reads files afresh,
   including after process restart. This is **not** unsupported mid-run SDK
   resource injection or extension reload. Installed skills still use the
   existing `/reload-skills` mechanism. Adaptive storage is deliberately outside
   all normal skill roots; never add it to PI/Harness skill search paths.

## Bounds and safety

- At most 32 successful native receipts, 2 save attempts, 3 full-body loads and
  12 KB loaded reference data per working run. No background/fleet generation.
- Query: first 2048 characters, at most 32 nontrivial keywords. At most two
  installed and two adaptive matches considered; aggregate load budget applies.
- At most 16 recipes per workspace/session scope; names are lower-case ASCII
  identifiers, descriptions at most 256 bytes, bodies 40–4096 bytes, complete
  files at most 8192 bytes. No bundled scripts, executables or installation.
- Current revision required for edits; exact repeats are no-ops and identical
  recipes under another name are rejected. Installed/shared/foreign skills
  cannot be overwritten. Other sessions/workspaces cannot load these recipes.
- Canonical home and real, non-symlink managed directories/files required.
  Cross-instance exclusive directory lock; a stale lock fails closed and needs
  operator inspection/removal, not automatic lock theft. Staged verification
  precedes atomic promotion; validation/read/revision failures retain old data.
- References and generated recipes are data, never authority, system prompt,
  tools, permissions, installation rights or secret access. Tool/approval/review
  policies remain independent. A skill cannot authorize a new task.

## Honest limits

Keyword relevance is intentionally modest, not semantic inference. Receipts
prove successful native tool execution, **not** that the proposed procedure is
correct: model synthesis remains fallible and untrusted. Prompts prohibit secret,
private-history and output copying; arbitrary natural-language secrets cannot be
reliably classified by a schema. Storage stays local (0600 files, 0700 managed
directories); only matching bounded references enter the current model context,
just as other task data does. Operators must leave this opt-in off where any
model-authored persistence or later model-context disclosure is unacceptable.
No guarantee against hostile same-UID filesystem mutation is claimed. Locks
coordinate cooperating Harness writers, not an adversarial OS principal.

There is no LLM-provider/network dependency in the lifecycle tests: they exercise
real PI SDK resource loading, extension dispatch, host receipts, plugin save and
context results without exporting private history or invoking a live provider.
