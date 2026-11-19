# Automatic native-compaction recovery

SDK threshold/overflow compaction runs inside a working turn, not through the
host's explicit compact() operation. The PI adapter records non-cancelled failures
as `harness-native-compaction-v1` custom session metadata. It is durable but never
part of model context. A later successful native/manual compaction supersedes it.

An extension may intentionally cancel compaction, for example to yield to work.
That alone is not a failure. A hook cancelling an incomplete automatic summary
must explicitly append the same custom entry with `{state: "failed", reason:
"threshold" | "overflow"}`. Do not append it when its signal is aborted, for
manual operations, or during a retry backoff. It contains no conversation text,
provider error or credentials. Minerva's hook implements this distinction.

At a settled host boundary, maintenance adopts a new failure receipt once and
uses the existing archive-linked handover. The full original transcript is
archived and the new session gets a small checkpoint instructing it to inspect
the archive, reconcile effects and preserve task authority. This failure path
makes no additional summary-model request and no native summarization retry;
it therefore does not depend on a healthy or fast summarizer. Prepared transitions
and existing recovery holds remain binding; disabled automatic handover is not
overridden. Failure receipts are deduplicated across restart.

Rotation does not replay the working input or claim that interrupted work was
completed. The normal independent continuation assessment still determines what
remaining work may run. A failed productive prompt keeps its failed outcome;
maintenance can nevertheless prepare a healthy context for the next authorized
input. Genuine stops/cancellation do not initiate a handover.
