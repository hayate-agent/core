<!-- SPDX-License-Identifier: Apache-2.0 -->

# Main result follow-up within an existing mandate

Dispatcher submission captures the current parent task identity, original operator
request, depth, deadline and chat anchor in the execution ledger. This checkpoint
is supplied by the host, never by tool arguments or worker output. Existing tasks
without a checkpoint still deliver results as data but cannot authorize result
orchestration.

On a result turn Main can discover and delegate derived work, explicitly continue,
or use the existing optional completion assessor, within that stored mandate.
The host reconstructs continuation metadata from the ledger and supplies the
original mandate separately from untrusted result text. Results cannot replace
operator identity, expand scope, waive constraints or grant new permissions.

Validation requires a completed, non-revoked child and the same live parent task
and depth. Stopped/completed/replaced tasks, cancelled children, expired grants,
exhausted chains and worker-owned sessions do not authorize result follow-up.
Checks run again before execution and after completion assessment. Existing
worker nesting restrictions, tool permissions, approvals and independent review
remain separate gates. The normal twenty-follow-up bound and durable inbox/outbox
checkpoint are reused.

There is no new per-tool semantic classifier or natural-language sandbox. Main
reasons about scope using the original operator request; the optional completion
assessor remains advisory. This change adds no mandatory dispatcher lifecycle,
Matrix behavior, bootstrap mechanism, semantic recovery or deployment action.

Tests exercise the actual PI tool-call hook with a real Harness and dispatcher
ledger: result-derived delegation, explicit and automatic continuation, final
completion, retained review denial and rejection after mandate completion. Other
regressions cover durable duplicate results and stopped, replaced, expired,
stale-depth, cancelled and worker-owned authority.
