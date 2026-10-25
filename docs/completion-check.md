# Semantic completion fallback

The optional completion assessor is invoked after successful working turns when
no explicit continuation checkpoint exists. Explicit waiting/blocked/completed
plans are never overridden. API runs, controller-owned nightly work, paused or
stopping Harness instances, queued work, cancelled turns and exhausted chains
are excluded. Conditions are rechecked after assessment; the ordinary durable
inbox/outbox checkpoint commits any follow-up. Working approval cleanup and
assessment cancellation use separate signals.

Installation configuration may supply a narrow task scope with a numeric deadline:

```yaml
completionCheck:
  authorizations:
    "matrix:!room:example.org":
      task: "Implement the approved update feature and its regression tests"
      expiresAt: 1793000000000 # explicit UTC epoch milliseconds; example only
```

Protect installation configuration at the infrastructure boundary. No tool or
settings overlay may edit these grants. Without a configured grant, the core uses
the original accepted chat input as a task anchor, captured before working execution
and persisted with the input. Generated follow-ups inherit that same anchor rather
than assistant replies. The classifier must distinguish actual work requests from
questions, status requests and quoted history. This distinction is model-advisory,
not a formal authorization proof. Non-chat scheduled inputs have no implicit anchor.

A reply saying work remains is never itself permission. Chat anchors have no
invented expiry: if the task contains a temporal limit without a numeric grant,
the classifier is instructed to return uncertain rather than guess its meaning.
This is not a deterministic natural-language deadline parser or full task registry.
New queued input suppresses follow-up scheduling; `/stop` aborts the assessment as
well as working execution and clears waiting work. Already committed work cannot
be undone by stopping. Installation grants take precedence over chat anchors.

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
