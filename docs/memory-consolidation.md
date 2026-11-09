# Periodic memory consolidation

The Core host adapter registers the trusted `memory-consolidation` service when
`memory.consolidation` is configured and memory is enabled. Policy lives in the
optional Plugins `src/memory-consolidation.mjs` module (Plugins PR #80).

Example persistent settings, merge with existing plugins:

```yaml
memory:
  enabled: true
  orchestration: consolidating
  consolidation:
    tier: frontier
    model: provider/explicit-cheap-model
    timeoutMs: 120000
plugins:
  - plugins/memory-consolidation.mjs
```

Install the reviewed plugin module at that path. Restart after configuring the
adapter/plugin; configuration is validated but this service is startup-bound.
No module is automatically downloaded or enabled. `frontier` schedules every two
hours; `local` every twelve. The tier is explicit, not guessed from model names.
Use an authenticated model in the existing model catalog. No dispatcher is needed.

The host uses the existing ephemeral runtime contract: no tools, third-party
extensions, skills, persona files, persisted transcript or source conversation
history. Each batch has a fresh random session ID. Only the supplied source batch
is sent to the configured model; choose a local model where cloud disclosure is
not permitted. Thinking is off. Timeout aborts the session; shutdown drains work.
Abort is cooperative: an unresponsive runtime cannot safely be killed in-process.

The existing memory service captures raw outcomes; the plugin queues bounded,
conversation-isolated batches and writes derived reported lessons through the
current provider. It never deletes raw source memory or upgrades claims into
verified facts. Provider failures preserve batches. See Plugins documentation for
queue budgets and persistence/replay limits. This is not a migration of old
memory: only captures after enabling the orchestrator enter its work queue.

Model/provider availability and actual live execution must be verified after
installation. Source merge alone does not activate this feature.
