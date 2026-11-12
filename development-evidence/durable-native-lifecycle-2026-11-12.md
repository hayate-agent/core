# Durable native lifecycle repair, 2026-11-12

Root causes verified in code and the local deployment:

- `/update` only reconciled skills/cron; it never fetched Core/Plugins/WebUI code.
- The prepared local owner configuration named `vanillacore-shikamaru.service`, while the running service was `hayate-shikamaru.service`, and omitted activation configuration.
- Native restart had a separate idle lease requirement. A request/worker waiting for its own restart could keep that lease busy forever.
- Shutdown used independent drain, abort, persistence and cleanup timeouts. IPC session selection could also delay starting shutdown.
- Direct CLI services without an external restart policy could simply exit75 rather than resume.

The repaired host path fences ingress synchronously, signals owners concurrently, applies one configurable default60s overall deadline, retains durable work, and restarts only after old-runtime close. A timed-out snapshot write is not retried concurrently. Existing StateStore writes are serialized; existing native unit validation requires SIGTERM, control-group shutdown and SendSIGKILL=no. Nonzero checkpoint failures propagate through the foreground owner instead of being masked as ordinary supervisor termination.

The native source updater is owned outside the runtime, not by a Main/Dispatcher task. It durably schedules checks/preparation, uses configured sources (public GitHub defaults; per-agent overrides), builds in isolated directories, validates before selection, and publishes the selected installation only after old-runtime exit. Containers retain their image owner. Native current selection supplies all three source trees; external standalone WebUI services remain independently supervised. The selected launcher implementation is loaded too, so the old implementation does not remain the active update owner forever.

Concurrent source requests/status writes are serialized; prepared notifications wait for the requesting client's status acknowledgment with a bounded fallback. Supervisor shutdown prevents selection. Manual/disabled update policy is retained. Model-visible mutating lifecycle calls require an active authenticated operator conversation or explicit startup authority (automatic installs / `lifecycle.agentRestart`). Repositories and versions are never model-provided tool parameters.

Validation before final merge integration:

- Core full suite: 1,944 tests, 1,943 pass, 0 fail, one optional skip.
- Latest focused lifecycle/process suite: 17 pass, zero failures.
- Host owner suite: 295 pass, zero failures.
- Real compiled direct CLI and launcher process tests exercise `/restart` with a never-resolving plugin cleanup, a 2s total budget versus a 60s turn grace, old listener exit and a live replacement. No forced kill, task cancellation or ledger edits.
- Earlier real Git/npm three-repository process probe verified receipt -> checkpoint -> old process exit -> selected replacement with retained execution identity; subsequent filesystem cleanup after a host reboot removed `/tmp` evidence. Work and fresh evidence are now retained under `~/.local/share/hayate-lifecycle-work`, not disposable `/tmp`.

Source configuration, semantics and commands are documented in `docs/native-lifecycle.md`. Full final-head validation, remote CI and actual deployment/readback are required separately; this source evidence does not claim rollout.
