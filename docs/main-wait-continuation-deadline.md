# Main wait-to-continue deadline preservation

When independent assessment replaces a proposed bounded wait with productive
continuation, settlement must preserve the registered deadline. On a first-turn
wait the deadline exists only on the input checkpoint: it is not yet present on
the durable task. Dropping it can admit later work outside that scheduling window.
The assessment may shorten the window, never extend it. This change does not
resume paused workers, remove running-child gates, or declare an unfinished
operator mandate complete.

Four regression cases cover missing, longer and shorter assessed expiry, durable
reload after expiration, and a next Main turn without a worker. Against the
previous implementation three fail; with the fix all four pass.

Final verification after integrating main c382b31 (PR324):
- npm run build: passed.
- Complete transitive targeted suite, no excluded files: 1425 tests, 1424 pass,
  0 fail, 0 cancelled, 1 skip. Includes upstream stale-topic foreground and
  benchmark timer corrections alongside both fixes here.
- The merge resolution preserves BOTH admission-presence selection and upstream
  superseded-topic gating.

Earlier verification on main 76bfa0e:
- npm run build: passed.
- Transitive targeted suite after build, including the starvation correction below,
  excluding the independently failing benchmark-runner.test.ts: 1369 tests,
  1368 pass, 0 fail, 1 skip.
- benchmark-runner.test.ts on unchanged 76bfa0e and the candidate: 4 pass,
  9 cancelled (unreferenced timeout leaves a pending promise without an event-loop
  handle). Upstream PR324 subsequently corrected the timer; final integrated
  verification above no longer excludes that file.
- Original validator branch transitive suite: 1340 tests, 1339 pass, 0 fail, 1 skip.

## Independent review correction: admitted-task starvation

Review found that queue selection picked the first active proposal before checking
its admission. A deferred assessment on task A could therefore prevent a later,
already admitted task B from executing indefinitely. Selection now skips proposals
without an admission; all existing admission validation, pause, dependency, budget
and expiry gates remain unchanged. Two regressions (with and without restart)
fail on unchanged main and pass with the correction. They verify B runs once,
A stays unchanged and fenced, and repeated ticks do not duplicate work.
Independent follow-up review found no blocking findings for this correction.
This demonstrates a general scheduling defect, not attribution of a particular
remote incident without its persisted records.

These are build/test results, not deployment activation evidence. The previously
merged validator retry changes (PR318) and this deadline correction are distinct
from investigation of stale-topic selection and fleet activation.
