# Benchmarking pinned models and reasoning levels

`/benchmark` measures a model and reasoning level under **production conditions**: the
same dispatcher, worker runtime, session logs and acceptance commands that a real
delegated task uses. It is not a prompt-latency script — it answers "what does this
model cost me on this backend when it does real work".

## Quick start

```yaml
# <home>/benchmark/suites/coder-levels.yaml
name: coder-levels
repeats: 3
cases:
  - id: cache-reset
    task: |
      Eine der Operationen in store.js ist fehlerhaft: sie hinterlässt Einträge, die
      wie gelöscht aussehen. Finde sie und behebe die Ursache. node test.js muss
      danach durchlaufen; test.js ist eingefroren.
    model: homelab/qwen3.8-27b-coder
    thinking: xhigh
    fixtures:
      - path: store.js
        contents: |
          class A { ... }
      - path: test.js
        contents: |
          const a = require("node:assert/strict");
          ...
    deliverables: [store.js]
    acceptance: node test.js
    verifier: node -e "const s=require('fs').readFileSync('{workspace}/store.js','utf8');process.exit(s.includes('clear()')?0:3)"
    referenceSolution:
      - path: store.js
        contents: |
          class A { ... }   # der nachweislich funktionierende Stand
    expectation: ALL PASS
```

Only `name` and `cases` are suite-level; `repeats` is optional (default 3) and can be
overridden per case. The pin lives on the **case**, so one suite can compare levels,
models or both, and a second case with the same fixtures but `thinking: off` is the
usual way to express a ladder.

```
/benchmark coder-levels      # starts the run, progress arrives as cases finish
/benchmark status
/benchmark report coder-levels
```

Each case is submitted as a normal worker task with a **strict pin**. The run answers
immediately; per-outcome progress and the final table are delivered afterwards.

## What a pin guarantees

`resolveWorkerPin()` (`src/model-roles.ts`) is deliberately stricter than model roles:
an unavailable model or an unsupported thinking level **fails the run** instead of
falling back to the default model. A benchmark that silently measured a different model
would be worse than no benchmark. Valid levels are those the *server* accepts — for the
Qwen models on the homelab backend that is `low`, `medium`, `xhigh` (plus `off`, which
PI sends as `enable_thinking: false`). `minimal`, `high` and `max` are rejected by the
chat template.

`pinned: true` is set only by trusted submitters (the benchmark runner). A worker cannot
pin itself, and `pinned` is not a model-facing dispatch parameter.

## What makes a run count

A coding case declares four things that keep the measurement honest:

| field | who sees it | purpose |
| --- | --- | --- |
| `fixtures` | worker | the starting state, hashed before submission |
| `deliverables` | worker (via the task) | the file(s) the worker is *supposed* to change |
| `acceptance` | worker may know it | the frozen test the task points at, run in the workspace |
| `verifier` | hidden | the contract check, run from a **private directory** outside the workspace |
| `referenceSolution` | hidden | applied only during the preflight to prove the case is solvable |

Workers share the filesystem with the harness, so anything inside the workspace is
readable by them. The verifier therefore runs with the private directory as its working
directory and is only handed the workspace path through `{workspace}`. Naming the
acceptance command in the task text is fine ("make `node test.js` pass" is how a coding
task is stated); naming the **verifier** is rejected, because it is the hidden grader.

### Preflight: the instrument is checked before a worker is used

Before anything is submitted, the runner checks the case itself:

* the untouched fixture must **fail** the contract check — a case that already passes
  measures nothing and is reported as `preflight-failed` without burning a worker;
* with a `referenceSolution`, that fix must **pass** acceptance *and* verifier — a case
  nobody can solve is unmeasurable.

Both failures were observed with a hand-built fixture: a case where only the broken
method existed was solvable by a `thinking: off` worker in four turns, which would have
produced a clean-looking table out of a task that discriminated nothing.

### Verified means all of these

`verified` is true only when the worker completed, `tampered` is empty, the acceptance
and verifier exits are 0, **and** the worker session log shows exactly the pinned model
and thinking level (`pinMatches`). File changes are split three ways:

* `fixed` — declared deliverable changed: expected, not a defect;
* `tampered` — anything frozen changed (typically the test): disqualifies the run;
* `extra` — files the worker added: reported, not disqualifying; acceptance and verifier decide.

## Integrity gates

Five checks decide whether a number may appear in the report:

1. **Fixture checksums** — every fixture is hashed before submission and re-checked
   after the worker finished. A change outside the declared deliverables (`tampered`)
   marks the outcome
   unverified: the worker edited its own test and the acceptance run proved nothing.
2. **Task isolation** — the task text may not contain the `expectation` or the
   `verifier` command, and each attempt runs in a fresh worker session. Observed in
   practice: a worker with filesystem access rebuilt its fixture out of the parent
   transcript, so a case whose answer is recoverable from surrounding context measures
   nothing.
3. **Acceptance outside the worker** — `acceptance` runs in the prepared workspace after
   the worker is done; the worker's own claim of "tests pass" is never sufficient.
4. **Verifier outside the workspace** — the hidden contract check runs with a private
   directory as working directory, so grading logic is not readable where the worker is.
5. **Pin match** — the worker session log has to show the pinned model and thinking
   level. A run that silently executed at another level is excluded rather than averaged
   in; this caught a run submitted as `off` that actually ran `medium`.

Unverified, tampered, preflight-failed, timed-out and cancelled outcomes are listed
separately and excluded from `OK`.

## Metrics and the epoch

Metrics come from the worker's own session logs (`sessions/dispatch_<id>_*`), summed
across attempts including runtime restarts:

| Field | Meaning |
|---|---|
| `assistantTurns` | model turns, including retries |
| `inputTokens` / `outputTokens` | as recorded per assistant message |
| `reasoningChars` | characters of thinking text (a budget proxy, not tokens) |
| `durationMs` | **sum of per-turn model time**, not wall clock |
| `toolCalls` | tool calls attributed to worker turns |
| `wallMs` | recorded by the runner around the whole attempt |

Queueing and model time are therefore distinguishable; do not read `durationMs` as
elapsed time.

Every run stores an **epoch**: build revision, `models.json` fingerprint and the hashes
of the settings drop-ins (`settings.local.yaml`, `settings.d/*.yaml`, `config.json`).
`epochDifferences()` refuses to compare runs across epochs — a changed model config or
settings file invalidates the comparison. If the backend configuration changes
mid-campaign, the earlier numbers are history, not evidence.

## Settings

```yaml
benchmark:
  enabled: false      # no worker is submitted while disabled
  capacity: 1         # serial on a shared GPU: two parallel requests just share compute
  repeats: 3          # per case and level; report uses median and p95
  caseTimeoutMs: 900000
```

The block is **not** live-reloadable and not mergeable field-by-field across layers.
That is intentional: a running measurement must never have its conditions changed under
its feet. Restart the agent to change it.

## Limits worth knowing

- `reasoningChars` is a proxy. Token-based thinking cost would need provider usage data
  that the backend does not return for these models.
- A single case is not a comparison. Use several cases and the repeats; read medians
  and p95, and treat a run with unverified outcomes as no evidence at all.
- Prompts that force an answer format are bad instruments: they penalise non-thinking
  runs by inflating the forced output instead of measuring work.
- Workers share the filesystem with the parent and can read session logs. Keep fixture
  content out of the parent transcript; generate files with a script rather than
  pasting them into the conversation.
- Reports are only as valid as the epoch they were measured in.
