# Semantic completion fallback

The optional completion assessor is invoked after successful working turns when
no explicit continuation checkpoint exists. Explicit waiting/blocked/completed
plans are never overridden. API runs, controller-owned nightly work, paused or
stopping Harness instances, queued work, cancelled turns and exhausted chains
are excluded. Conditions are rechecked after assessment; the ordinary durable
inbox/outbox checkpoint commits any follow-up. Working approval cleanup and
assessment cancellation use separate signals.

Enable only through installation configuration:

```yaml
completionCheck:
  authorizations:
    "matrix:!room:example.org":
      task: "Implement the approved update feature and its regression tests"
      expiresAt: 1793000000000 # explicit UTC epoch milliseconds; example only
```

The task scope and deadline must be provided by a trusted operator/deployment,
not inferred from assistant replies. Protect installation configuration at the
infrastructure boundary. No tool or settings overlay may edit these grants.
There is currently no automatic extraction of trusted task grants from ordinary
chat: without a grant this fallback does not run. A reply saying work remains is
not itself permission. This is an opt-in foundation, not a complete task registry.

The classifier uses the existing ephemeral tool-free reviewer adapter (no skills,
project context or extensions). It receives bounded task/request/reply text and
returns JSON. Invalid, uncertain or failed assessments do not continue. A ten-second
deadline requests best-effort abort and bounds the waiting caller; runtime open or
cleanup may still remain pending if the adapter does not honor cancellation.
This does not establish hard process isolation or model semantic accuracy.

The existing twenty-follow-up chain cap and normal tool/review approval policies
remain in force. Model output is advisory and can misclassify task scope; grants
should therefore be narrow and short-lived. Revocation currently requires changing
installation configuration and restart. /pause and /stop remain immediate runtime
controls. Deployment is required; a source build is not activation evidence.
