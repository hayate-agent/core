# Hashtag reference lookup

`/hashtags` lists the tags indexed in the current Harness conversation.
`/hashtags #slug` reads the referenced retained user messages and shows their
indexing date, a short verbatim excerpt, exact runtime session ID and the existing
`/resume <session-id>` command. Copy/run that command to reopen the session;
lookup itself never opens, selects or activates a session or task. The original
history remains available through the existing session navigation. Missing
sessions/messages produce an explicit unavailable result, not a fabricated
summary. There is no `/topic` command or alias.

## Minimal parsing and provenance

Only fresh channel user inputs which reach a real runtime user transcript entry
are indexed. API/host/tool/scheduler/continuation text is not tag intent. Tags
are case-insensitive ASCII `#slug` tokens: start with a letter, then letters or
digits, with optional single hyphens between components; whitespace before and
whitespace, end-of-line or ordinary sentence punctuation after. Examples:
`#release`, `#content-fix`. Tags do not route prompts or grant authority.

The conservative parser skips fenced and indented code, Markdown blockquotes,
inline backticks, single/double quoted strings, Markdown links and XML-style
source blocks. Unbalanced quoting ignores the remainder. This is not semantic
classification: pasted plain prose cannot be distinguished from authored prose.
Quote, fence or wrap source material explicitly; put intentional tags on a plain
line. Mid-turn steering and legacy history are not backfilled. Older sessions
without tags remain usable through `/sessions` and `/resume`.

The durable Harness state holds only tag, runtime session ID, transcript message
ID and indexing timestamp, scoped to the exact conversation key. It does not
copy message bodies or rewrite memory. Native PI and external SessionProvider
history reads enforce the same conversation scope as existing session navigation;
no global session search or cross-conversation index is added. In shared rooms
this retains the existing room-level authorization boundary, not a new private
per-sender history. Providers must retain referenced history for lookup to work.

## Output labels

Fresh operator channel turns capture normalized tags on their durable originating
assignment. Main replies and dispatcher question/status/result envelopes use the
same `#hashtags #rollout · …` prefix: unique tags in ASCII alphabetical order,
matching the parser. The host renders it, not the model. The model receives only
the current assignment's labels as metadata; labels never grant authority.
Queued turns, task continuations and dispatcher executions retain their original
labels through the existing inbox/assignment/execution state. Delivered Main
replies retain label metadata in the durable outbox, including retries/restart.
A late worker result uses its exact stored execution's originating labels, not
the conversation's newer task. Untagged and legacy work remains untagged. Internal
worker transport keeps the raw result; user-facing delivery adds the prefix once.
Returned `#other · …` prefixes cannot override a tagged assignment's host prefix.

Only operator text is parsed. Generated labels are not new hashtag references and
are not copied into operator transcripts or the reference index. API inputs,
worker prose and host result text do not create tags. Native and external session
providers use the same Harness-owned durable metadata, scoped to the existing
conversation/execution identities, without global session searches.

No context switching, autofocus, routing mode, profile changes or LLM
summarization is part of this feature.
