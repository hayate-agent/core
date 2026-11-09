# Benchmarking pinned models and reasoning levels

`/benchmark` measures a model and reasoning level under **production conditions**: the
same dispatcher, worker runtime, session logs and acceptance commands that a real
delegated task uses. It is not a prompt-latency script — it answers "what does this
model cost me on this backend when it does real work".

## Quick start

```yaml
# <home>/benchmark/suites/coder-levels.yaml
model: homelab/qwen3.8-27b-coder
thinkingLevels: [off, medium, xhigh]
taskIsolation: require-new-session
repeats: 3
cases:
  - id: cache-reset
    task: |
      /tmp/cache-reset stores counts per key but reset() only inserts empty objects,
      so total() keeps growing. Fix it and make the test pass.
    fixtures:
      - path: main.js
        content: |
          const cache = new Map();
          ...
    acceptance:
      - cmd: node test.js
        expect: ALL PASS
```

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

## Integrity gates

Three checks decide whether a number may appear in the report:

1. **Fixture checksums** — every fixture is hashed before submission and re-checked
   after the worker finished. A changed fixture (`fixtureDrift`) marks the outcome
   unverified: the worker edited its own test and the acceptance run proved nothing.
2. **Task isolation** — with `taskIsolation: require-new-session` the runner refuses to
   submit if a previous task for the same parent is still active. Fixtures and
   expectations must not be recoverable from a previous run's context.
3. **Acceptance outside the worker** — `acceptance` commands run in the prepared
   workspace after the worker is done; the worker's own claim of "tests pass" is never
   sufficient. The expectation strings are kept out of the task text on purpose: a
   worker that reads its own task transcript cannot copy the expected output.

`verified` is true only when the task completed, the acceptance commands matched and no
fixture drifted. Unverified, drifted, timed-out and cancelled outcomes are listed
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
