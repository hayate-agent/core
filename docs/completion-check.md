# Semantic completion fallback

The bundled advisory classification wording is owned by `harness/plugins` and
injected into the host assessor. Core keeps eligibility, task anchors, deadline,
cancellation, output validation and durable follow-up admission. No authorization
checks or task-state persistence move into the wording implementation.

`completionStrategy: plugins/my-completion.mjs` selects a trusted local startup
module exporting default `{apiVersion:1, prompt(input, reply, authorization, now)}`.
It returns the model prompt string; it cannot change host parsing or deadline
checks. Model classifications remain advisory. Missing/invalid modules fail startup,
never silently select another strategy. No sandbox, download or background resource
lifecycle is provided; prompt methods must be pure. The CLI
injects the bundled default when unconfigured. Other hosts calling assessCompletion
must inject a prompt strategy; omission disables classification rather than importing
a concrete default from Core. Existing timeout and numeric grants remain. The host
owns the repetition budget; total continuation depth is not an assessment limit.
Build/merge does not activate a running installation.

## Local prompt strategy lifecycle

The administrative `/completion-strategy` plugin supports `status`, `use <module>`,
`disable`, `baseline` and `reload`. Module paths are trusted executable code, resolved
relative to Harness home; this is not a remote code loader or an untrusted plugin
sandbox. These commands do not modify task grants, deadlines, model selection or
operator-stop semantics. Disable removes advisory classification only.

The installation selection (configured module or bundled default) is captured at
startup. `baseline` removes the local override and restores that captured generation;
it does not reload changed installation code. `use` and `reload` cache-bust the entry
module, while transitive dependencies retain Node's ESM cache semantics. Node retains
imported generations until process exit, so this is not an unbounded hot-code service.
A disabled or baseline selection reloads to itself. Paths containing whitespace are
not supported by the command grammar.

Local overrides persist as `completionStrategy` in `settings.local.yaml`: a path
replaces, null disables, absence restores the installation selection on restart.
Changes reserve the Harness idle boundary, validate before persistence, then publish
the new generation only after durable save. Busy owners reject and require a later
explicit retry; invalid modules or failed writes retain the active generation. Each
assessment captures its prompt function once. A module can still execute arbitrary
trusted code during import; failed imports are not transactional side-effect rollback.
No running installation changes until this implementation is deployed.

The optional completion assessor is invoked after successful working turns,
including turns with explicit continue or timed-wait checkpoints. Existing scheduled
next steps are preserved. A model-authored timed wait does not veto an independently
assessed safe continuation: replacing it clears the pending wait in the same durable
settlement. A waiting verdict retains the bounded timer, and real pending dependencies
still fence execution. Self-reported waiting/blocked/completed plans may
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

The host's twenty-consecutive-attempt allowance without fresh host evidence and
normal tool/review approval policies remain in force. Productive progress can
therefore continue beyond twenty total turns. If an eligible assessment is
inconclusive, a self-reported completed checkpoint is not sealed as completion:
the active mandate is retained for the existing bounded recovery assessment
(three consecutive failed/inconclusive durable attempts with its existing retry
delay and attention escalation). Recovery reserves an attempt durably before
inference so interruption cannot create uncounted retries. A usable decision,
including a `continue` nudge, clears that failure sequence before its admission is
persisted. Ordinary semantic assessments and working follow-ups do not charge
this recovery-error budget. The separate host evidence/stagnation allowance
above is not this retry counter, nor is it the independent code-review `maxTurns`
gate; this distinction does not relax either gate.
No executable next step is invented on failure. Empty/NO_REPLY output cannot
independently confirm completion. Valid non-executable verdicts can correct a
self-reported completion and close a task-bound dispatcher result without replay.
Explicit scheduled next steps and independently confirmed timed waits remain preserved.
Model output is advisory and can misclassify task scope; grants
should therefore be narrow and short-lived. Revocation currently requires changing
installation configuration and restart. /pause and /stop remain immediate runtime
controls. Deployment is required; a source build is not activation evidence.
