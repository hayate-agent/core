# Semantic completion fallback

The bundled advisory classification wording is owned by `harness/plugins` and
injected into the host assessor. Core keeps eligibility, task anchors, deadline,
cancellation, output validation and durable follow-up admission. No authorization
checks or task-state persistence move into the wording implementation.

`completionStrategy: plugins/my-completion.mjs` selects a trusted local startup
module exporting default `{apiVersion:1, prompt(input, reply, authorization, now)}`.
It returns the model prompt string; it cannot change host parsing or deadline
checks. Model classifications remain advisory. Missing/invalid modules fail startup,
never silently select another strategy. No sandbox, download, hot replacement or
background resource lifecycle is provided; prompt methods must be pure. The CLI
injects the bundled default when unconfigured. Other hosts calling assessCompletion
must inject a prompt strategy; omission disables classification rather than importing
a concrete default from Core. Existing timeout, numeric grants and chain cap remain.
Build/merge does not activate a running installation.

The optional completion assessor is invoked after successful working turns,
including turns with explicit continue or timed-wait checkpoints. Existing scheduled
steps and bounded waits are preserved rather than overwritten by an advisory result.
Self-reported waiting/blocked/completed plans without an explicit scheduled step may
be reassessed against the original task. Other retained active mandates without a
next step can be independently assessed under their own original anchors. Pending
child executions do not suppress assessment; they still block execution of their
associated task. Legacy dependencies without task identity conservatively block all
autonomous execution. A registered bounded wait is handled by the durable task
scheduler, not a release webhook. API runs, controller-owned nightly work, paused or
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
project context or extensions). It receives bounded task/request/reply text, plus
host-provided conversation evidence: up to eight recent user/assistant excerpts
of at most 2000 characters each and up to eight retained task summaries. Excerpts
survive restart; this is not full transcript reconstruction. Context is evidence,
not additional authority. Completed or stopped historical mandates are not
resurrected automatically; a fresh explicit work request has its own task anchor.
The classifier returns JSON. Invalid, uncertain or failed assessments do not continue. A ten-second
deadline requests best-effort abort and bounds the waiting caller; runtime open or
cleanup may still remain pending if the adapter does not honor cancellation.
This does not establish hard process isolation or model semantic accuracy.

Numeric grant deadlines are persisted on generated inputs, inherited by later
follow-ups without extension, and checked again before execution (including after
asynchronous PI setup). Expiry prevents a new working prompt; it is not a timer
that interrupts an already-running prompt. Other runtime adapters must honor the
host `beforeExecution` guard after their own asynchronous setup.

The existing twenty-follow-up chain cap and normal tool/review approval policies
remain in force. Model output is advisory and can misclassify task scope; grants
should therefore be narrow and short-lived. Revocation currently requires changing
installation configuration and restart. /pause and /stop remain immediate runtime
controls. Deployment is required; a source build is not activation evidence.
