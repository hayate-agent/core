# Tool-result pruning

Enabled by default, without a model call. The Harness PI adapter uses the `context`
hook before provider requests to project older oversized tool results. Persistent
conversation history is not rewritten. Compaction and handover remain separate.

```yaml
toolResultPruning:
  enabled: true
  proactivePruneTokens: 12000
  minResultChars: 4000
  maxResultChars: 2000
  keepRecent: 6
```

The same partial object is allowed in `<home>/settings.local.yaml`; installation
and overlay changes are loaded at startup. There is no pruning chat command yet.
`enabled: false` opts out. Token budget is an approximate trigger using UTF-8 bytes
of tool text divided by four, not a tokenizer or a hard final-context limit.

Only old successful all-text tool results above the size threshold are candidates.
The most recent `keepRecent` results, errors, images/mixed content, user messages
and assistant/tool-call messages stay intact. This intentionally does not guarantee
that every large context becomes small. A single current result may still be large.

Each shortened result retains its toolCallId, name and other metadata. Text includes
a SHA-256 content digest, original length, toolCallId and bounded head/tail excerpts.
Exact duplicate content from the same tool can reference the earlier result's ID;
a repeated command alone is never sufficient. This reference may itself point to
a shortened result, not necessarily a full copy still present in the model context.

The original remains in native session history. There is no new tool for fetching
arbitrary old tool results by ID; the agent can re-read the source or inspect the
session history when authorized. Outputs of non-repeatable operations should be
saved as durable task artifacts rather than relying on model context as storage.
The excerpts are deterministic truncation, not semantic summaries. All source text
remains untrusted, whether shortened or not.

Review sessions use an ephemeral resource-free adapter path and do not load this
hook. Unit tests verify immutability, exact deduplication, ID preservation, exclusions,
thresholds and opt-out. This feature changes provider input size; provider-side
cache effects and savings depend on the model and session workload.
