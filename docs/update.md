# Local overlay reconciliation

`/update status` and `/update apply [skills|cron|all]` are administrator commands.
They verify infrastructure-pinned protected content before examining or reloading
already provisioned local sources. They do not fetch remote changes, pull Git,
install packages, replace core code or import plugins.

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

This is the first local reconciliation slice, not the complete requested remote
update system. Trusted artifact sources, staged immutable versioned bundles,
manifest verification and cross-component activation/rollback remain follow-up.
