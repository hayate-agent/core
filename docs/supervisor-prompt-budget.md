# Supervisor prompt budget

The host gates the complete string passed to `AssessmentBackend.review`, for
built-in and configured prompt strategies: at most **56000 UTF-16 code units**
and **56000 UTF-8 bytes**, including instructions, JSON escaping and metadata.
`ceil(length / 3.5) <= 16000` is an estimated text-token count, not an actual
model-token guarantee. Provider wrappers, tokenizer differences and output tokens
are outside this string contract.

For the selected task, `context.retained` carries host-collected sections, not
model copies: the original mandate, saved `next` plus technical recovery state,
the persisted recent conversation excerpts (`recentMessages`, survive reload)
and `workers` — execution-store outcomes bound by `dependency.taskId` only
(task/attempt IDs, status, restarts, diagnostic, bounded result marked as an
untrusted claim; unrelated executions are only counted, tokens and receipts are
never exported). When the full render exceeds the gate, the fallback keeps these
sections before transcript observations, in that order, with fixed per-entry
caps (worker result 1000, message 1000, newest first) and lists every shortened
or omitted section in `retained.truncated`. A full render has no marker.

The existing automatic collector remains authoritative for evidence selection.
Projection preserves the full exact authorization and numeric deadline; optional
payloads are selected mechanically: latest current transcript, settled reply,
then retained archive evidence and other historical ingress. A minimal projection
that cannot fit, a throwing renderer or an oversized custom renderer produces the
existing `unavailable` diagnostic without a backend call. The final rendered
string is never blindly sliced. Installed custom strategies remain trusted code;
the byte gate does not prove that custom wording faithfully represents authority.

Tool envelopes retain IDs, names and error state. Truncated arguments are explicit
`argumentsExcerpt` data, not a purported complete arguments object. Truncated
legacy text is labelled incomplete rather than reconstructed. Sources, truncation,
original lengths and omitted observations are visible. Original mandates and
archive files are not rewritten by projection. Export status distinguishes a
successful empty transcript from missing support/storage and a failed export.
Evidence gaps are not evidence that no authorized work remains.

All transcript content and historical task records are untrusted evidence, not
new grants. This is payload bounding, not a secret sanitizer or an injection
proof. No marked-sensitive-field contract exists in these export types; secrets
in arbitrary unmarked text cannot reliably be detected here. No new recipient,
raw prompt log, credential access or historical file discovery is added.

This source change requires the normal package delivery to activate. Local tests
and builds do not change a running process. Mandatory continuation admission is
an independent change; this budget does not implement or replace that contract.
