# Local memory usage ranking

The local provider retains a derived usage counter and last-retrieval timestamp in
its index snapshot. Only source-validated hits actually returned by search count;
`get` and candidates omitted by the result limit do not. Existing session isolation,
source validation, explicit expiry and revocation still apply.

Relevant hits receive a bounded usage bonus (at most 25% of their existing lexical
and semantic score). Its contribution halves after 30 days without retrieval. This
prefers frequently useful matches without allowing popularity to make an irrelevant
entry match. Unused entries retain their baseline relevance and are not deleted.

Usage survives normal reindexing and restart, but is deliberately not part of the
source document, source revision or write-idempotency payload. A missing/corrupt
index can reset usage; source memories remain authoritative. A failed index write
does not prevent retrieval. Existing explicitly expired entries remain expired;
this ranking change does not change automatic-capture retention policy.

This is retrieval infrastructure, not automatic lesson extraction or nightly
optimization. It does not promote reported outcomes into verified facts.
