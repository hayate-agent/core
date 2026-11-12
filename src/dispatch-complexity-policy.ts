/** Shared, model-independent routing criteria for both classifier transports.
 * Operational authority/risk is not a proxy for reasoning difficulty. */
export const DISPATCH_COMPLEXITY_POLICY = `Choose the lowest sufficient capability, not the largest model by default.
Simple: factual/read-only lookup, status, deterministic mechanical edits, known runbooks and routine verification.
Medium: the default for bounded implementation, bug fixes in known code with tests, normal code review, multi-file changes with a clear approach, and routine research.
High: only genuinely difficult reasoning beyond medium: unresolved root cause with competing hypotheses, difficult concurrency/recovery invariants, novel algorithmic work or architecture with material unresolved trade-offs. Identify the specific hard reasoning, not just the project size.
Production, credentials, deployment, security-sensitive data, many files, long task descriptions, extensive constraints, requested tests/reviews and words such as implement/reconcile/recovery do not by themselves require high. Model selection never grants permissions or relaxes safety/verification gates.
A broad/long task must be scoped into bounded work; choosing high is not a substitute for a bounded task. When the reasoning difficulty is unclear, choose medium, not high.
Examples: known production credential rotation => simple; implement an ordinary API endpoint with tests => medium; review an existing PR against stated acceptance criteria => medium; diagnose an unexplained race with ambiguous external effects => high.`;
