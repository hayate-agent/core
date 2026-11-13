# Restart assessment must see the saved conversation before opening a model

## Reproduction

The startup supervisor called `completionEvidence` before any model session was
opened. Its only current-history source was `s.session.archiveEntries()`, so the
very first post-restart independent assessment received `current: missing` even
when PI's exact retained resume history existed. Repeated inconclusive reviews
could retain an open mandate under progressively longer backoff without giving
it a productive continuation.

A read-only comparison instantiated the installed Harness and the changed
Harness with the same retained operator task and a runtime exposing saved
activation evidence. Installed behavior: zero retained-history reads, zero
admissions. Changed behavior: one read-only history read, one independently
approved continuation. No production state/ledger was edited for the comparison.

## Changes

- Runtime exposes read-only evidence for its exact resume binding. A provider
  record must match binding ID, conversation and format, is pinned by a lifecycle
  lease, and is cloned before PI's in-memory format normalization.
- Native file discovery follows the existing mtime/header/cwd resume choice,
  without parsing all old sessions. An oversized newest header fails closed;
  it never silently substitutes an older conversation. No missing session is
  created. Existing JSONL files are not repaired or migrated by this read.
- Shared branch projection retains tool calls/results and handover evidence just
  like a live PI session. Malformed lines mark evidence incomplete.
- Completion evidence can resolve linked archives with the retained session ID
  even before model/session activation. A live session remains authoritative;
  empty live epochs are not filled from older history.
- The independent assessor receives actual host-loaded Core version/revision and
  process-start time, explicitly NOT task-completion or runtime-readiness proof.
  It never receives an available-but-uninstalled version as active.
- Newly accessible retained evidence or a changed loaded Core revision permits
  one tool-free boot reassessment before an old retry deadline. The durable
  fingerprint prevents repeated restarts bypassing backoff on unchanged evidence.
  Assessment/productive counters, task IDs, original grants and deadlines remain
  unchanged. No replay or work admission is inferred from the fingerprint.

The normal independent assessment and all pause/stop/expiry/legacy/uncertain-
effect guards still decide admission. This changes available evidence, not the
operator's permission or a worker's replay grant.

## Validation

Real SDK regressions cover exact active-provider binding, a newer unrelated
session, native cwd/mtime choice, missing history, older-format/missing-newline
files remaining byte-for-byte unchanged, malformed evidence, UTF-8 headers and
oversized-header refusal. Harness regression proves an authorized retained task
actually executes after recovery without a new user message, and unchanged boot
evidence does not reset or repeatedly bypass retry accounting.
