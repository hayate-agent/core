# Auxiliary model-work accounting

```yaml
dispatcher:
  countAuxiliaryRuns: false
```

Default false preserves independent memory consolidation and validator/reviewer
runtime sessions. True shares dispatcher capacity with consolidation and runtime
reviewer calls. Startup-bound: restart to change accounting. Nested runtime
validators reuse the productive parent's slot instead of waiting for a second
slot (avoids deadlock at capacity one). This does not grant backend concurrency
support or alter dispatcher.concurrentRequests validation.

Covered paths: runtimeReviewer sessions, dedicated HTTP code-review validators
(including isolated worktrees), HTTP complexity assessments and memory
consolidation. Dispatcher planning remains part of its productive task slot.
Queued admission supports cancellation without starting the model request; the
memory timeout includes admission waiting. External plugin-owned model calls that
do not use these host paths are not automatically intercepted.

This branch depends on the consolidation host adapter in Core PR #315.
