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

Verification on main 76bfa0e:
- npm run build: passed.
- Transitive targeted suite after build, excluding the independently failing
  benchmark-runner.test.ts: 1367 tests, 1366 pass, 0 fail, 1 skip.
- benchmark-runner.test.ts on unchanged 76bfa0e and the candidate: 4 pass,
  9 cancelled (unreferenced timeout leaves a pending promise without an event-loop
  handle). This pre-existing failure is not fixed or hidden by this patch.
- Original validator branch transitive suite: 1340 tests, 1339 pass, 0 fail, 1 skip.

These are build/test results, not deployment activation evidence. The previously
merged validator retry changes (PR318) and this deadline correction are distinct
from investigation of stale-topic selection and fleet activation.
