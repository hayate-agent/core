# Local overlay reconciliation

`/update status` and `/update apply [skills|cron|all]` are administrator commands.
They verify infrastructure-pinned protected content before examining or reloading
local sources. With an infrastructure-configured `skillUpdateSource`, applying
skills fetches the pinned bundle described below. No Git pulls, package installs,
core replacement or plugin imports are performed.

Results are per component, not an all-or-nothing transaction. Skills with parser
or discovery diagnostics are reported as activated-with-warnings, not a clean
update. Cron reload validates the replacement before retiring old jobs. Existing
callbacks/turns may continue. Requests through this coordinator are serialized;
other component-specific commands retain their own concurrency semantics.

Core always reports rollout-required (not a claim a newer version exists).
General plugin, MCP and settings reload is unsupported here. Use supported
component-specific commands or deployment. Status does not compare versions or
prove remote freshness. Protected hashes are integrity checks, not a sandbox or
filesystem write protection.

## Pinned skill download

Installation YAML may configure `skillUpdateSource: { url: "https://.../bundle.json",
sha256: "<64 lowercase hex characters>" }`. Runtime settings and `/update` cannot
change this trust pin. The infrastructure must protect the configuration itself;
this is not OS-enforced agent write isolation.

The UTF-8 JSON bundle is `{ "version": 1, "skills": [{ "name": "example",
"content": "---\\nname: example\\ndescription: Example\\n---\\nInstructions" }] }`.
Only SKILL.md text is supported, not companion scripts or arbitrary paths.
Limits: 512KiB downloaded, 64 skills, 32KB per content, slug names, matching
frontmatter names. HTTPS only, no redirects, 15-second download deadline; the
SHA-256 covers exact downloaded bytes. Skill instructions are trusted content,
not sandboxed or semantically proven safe by a digest.

Validated files are written to fresh UUID directories under `<home>/skill-updates`.
Candidate discovery is activated before the durable selection record is saved.
Activation failure restores the previous in-memory root and reloads discovery;
rollback failure is also an update failure. Restart reconstructs fresh files from
the saved bundle only if its digest matches the currently configured pin. A pin
change requires applying its matching bundle. Earlier directories are retained
because active turns may still reference them; automatic retention is not provided.
Filesystem checks are defense in depth, not protection against concurrent malicious
local writers. Atomic-save errors after rename can leave a durable candidate even
when in-memory rollback occurred; restart still revalidates its configured pin.

Bundle roots precede ordinary skill roots, so identical names override them. They
do not write protected files, plugins, policy or core. Applying other components
is not a cross-component transaction. This is not a general-purpose remote updater.
