<!-- SPDX-License-Identifier: Apache-2.0 -->

# Token and cost reporting

Use `/usage` or its alias `/tokens` in chat or the local terminal. Both are
ordinary, non-admin Harness commands and are listed through `/help`.

The output reports the **current runtime session's** cumulative input/output
tokens, cache reads/writes, total tokens including cache, and estimated USD cost.
While work is running, the displayed numbers are partial. The PI adapter reads
its native session statistics; missing counters from other runtimes are shown
as `unknown`, not fabricated as zero.

This is not account billing, an all-agent ledger, or a combined parent/subagent
counter. Fresh sessions and context handovers have separate counters. Cached
usage and provider/model price estimates are reported as supplied by the runtime;
a zero estimate does not establish that a provider charged nothing. `/status`
continues to provide the shorter model/token/context overview, and `/context`
shows current context-window usage rather than cumulative token consumption.
