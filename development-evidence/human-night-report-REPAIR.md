# Human-readable nightly report — repair candidate

## Reconciled source/runtime

- Installed `/opt/vanillacore-harness/build-info.json`: version 0.1.102, core revision `e4ebb7bbd622016aabaf646130e0ddb87be43337`, matching fetched core main at start.
- Controller already delegates rendering to harness/plugins. The old dirty core checkout (`ef854bf`) is not the installed source. Editing its former hardcoded report would repair the wrong version.
- Installed `dist/builtin-plugins/improvement-report.js` SHA256 `c4ea4a8d19fd895888eef8018b41a50211e11f0dec33d38f489b4105c50bd66e`. Current plugin source still prints JSON receipt fences and the unwanted final sentence.
- Own policy checked without exposing destination: enabled, 23–05 Europe/Berlin, 200 turns, PR/merge permitted, reportTo present, evaluator absent. No policy, state, task, budget or history was changed.

## Candidate identities / reproduction

No commits, pushes, PRs or deployment performed. Both branches are `fix/human-night-report` in NEW isolated worktrees:

- Core `/home/node/work/human-night-report`, base `e4ebb7bbd622016aabaf646130e0ddb87be43337`; staged candidate tree (excluding this evidence document) `ad39b8f233fcbd370e26f23b9a42cc6316716982`.
- Plugins `/home/node/work/human-night-report-plugins`, base `56082f1bb0c03513b920a722b2e3cd2fdbfcd0cd`; staged candidate tree `fa88d309f3fc278011cc18577491f9cce682bfda`.
- Plugin file `src/improvement-report.ts`, git blob `d9a216f73e254cd36916b0017ff14bf4906142d5`, SHA256 `2e206939ef70e86df87059a5ab5584b203dec1decf289e437642e163d630b273`.
- Core files: `test/improvement-report.test.ts`, `test/improvement-local-report.test.ts`, `test/fixtures/night-report-2026-10-28.json`, `development-evidence/human-night-report.local-plugins-lock.json`.
- Local development lock is explicitly NOT a production pin: same plugin base revision plus candidate renderer hash, used only with local sources. Production `plugins.lock.json` is untouched. Parent must review/deliver plugin first, then update the production revision/hash via normal PR workflow.

Reproduction in core worktree:

```
node scripts/materialize-plugins.mjs ../human-night-report-plugins development-evidence/human-night-report.local-plugins-lock.json
node --import tsx --test test/improvement-report.test.ts test/improvement-local-report.test.ts test/improvement.test.ts test/improvement-experiments.test.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/tsc -p tsconfig.json
```

All 14 targeted tests PASS; typecheck and build PASS. Log: local `development-evidence/human-night-report-tests.log` (ignored by Git). Both staged diffs pass `git diff --cached --check`.

Full suite attempt `node --import tsx --test test/*.test.ts` timed out at 180 seconds; NOT a full-suite pass. Before timeout it reported failures named `explicit cron report archives before delivery, survives archive failure without rerunning model, supplies scoped context` and `materialized review plugin enforces actual dedicated dispatcher execution and keeps its own budget`. Their causes were not established; do not label them pre-existing or fixed. Log `/tmp/human-night-full.log`. A follow-up guessed two nonexistent test paths and therefore ran no tests; not evidence of success.

## Change and boundaries

Only display changes: count/status summary; per-experiment expected benefit, before, tried/after, evidence/open points; bounded whole-entry output; local archive reference; no raw JSON or full turn replies. The unwanted sentence is removed. Local `improved` is expressly a reported local result, not deployment or independent approval. Rejected/inconclusive/empty cases remain explicit. URLs lose credentials/query/fragment; common credential forms and markup/control characters are removed before display. This is defensive display sanitization, not proof that arbitrary prose can contain no secrets.

Parser, deduplication, raw archive, scheduler, report delivery, budgets, completion semantics and pinned evaluator remain untouched. Real retained receipt fixture uses three outcomes from the latest night, with private absolute path prefixes replaced by `/local/...`; no turn transcripts/history included. Remote integration test still asserts full machine receipts survive in the archive even though chat no longer carries them.

Review tool status was inspected, not reset: existing escalated fingerprint `cbeaa734eece60e9ea0e688449dec3aa02bb01f0cdf7fa4eb8b5ef1466da9937` concerns unrelated dirty root recovery code, three rounds. It does NOT review these isolated trees. No candidate review PASS is claimed. Exact-tree parent review remains required before publication.

## Latest retained night: operator-ready explanation

Quelle: eigener Bericht `improvement/reports/2026-10-28.json`, SHA256 `e0bec13909a29f23b0b600914d424e7afa6d1dc68c72e125433889de669bbfef`. 54 Arbeits-Turns, 52 protokollierte Experimente: 45 lokal als verbessert gemeldet, 4 verworfen, 3 unentscheidbar. Das sind Versuchsergebnisse, nicht 45 bereits laufende Produktverbesserungen. Der Bericht vermerkt `outbox-pending`; daraus folgt kein Zustellnachweis.

Konkret wurde beispielsweise ein empfindlicher Sitzungstest robuster gemacht: Statt nach starren 40 ms weiterzulaufen, wartet der Kandidat auf den tatsächlich erreichten Zustand, höchstens 3000 ms. Mit absichtlich um 80 ms verzögerter Sitzungserstellung scheiterte der alte Test (0/1); der Kandidat bestand denselben Versuch (1/1), anschließend die TUI-Regressionen (11/11). Nutzen: weniger Fehlalarme bei langsamem Dateizugriff. Die vollständige Suite wurde für diesen Versuch nicht ausgeführt; Review und Übernahme waren noch offen.

Nicht alles war eine Verbesserung: Eine neue Array-Schleife beim Request-Hashing sollte mindestens 5 % schneller sein, war in zwei lokalen Messreihen aber 1,41 % beziehungsweise 0,30 % langsamer. Sie wurde zurückgenommen. Eine strengere Prüfung gespeicherter Modell-Metadaten bestand zwar ihre 12 gezielten Tests, blieb wegen 514/515 Gesamttests und ungeklärtem TUI-Fehler unentscheidbar. Diese Ergebnisse dürfen nicht als Erfolg verkauft werden.

## Read-only GitOps audit: the other agents

Actual names established from CURRENT fetched overlays `origin/main` `0ea198a376401e0ec6edcd772374fd06c61455a2`, `agents.json`: **che-guevara** and **randy-waterhouse** (besides Severus). The local checked-out overlays file was stale and listed only Che; it was not used to infer the second name. Registry history includes `22b45f2` (shared image promotion to independent agent repositories) and `ff0a9be` (independent overlay selection). Historical `internal-agentos-reference` is explicitly inactive, not configuration evidence.

### Che Guevara

Read-only repository clone `/tmp/night-audit-che`, HEAD `15c2cdaaa4e7d1061f0be29c3e4665760f9815ca`. Tracked files contain NO improvement.yaml or cron configuration. `kubernetes/kustomization.yaml:9-11` builds the config map from harness.yaml, models.json, SOUL.md, VOICE.md only. `kubernetes/agent.yaml:48-89` initializes the workspace and mounts those files; no step creates improvement.yaml. `harness.yaml` has Europe/Berlin timezone, not an improvement opt-in. Deployment introduction `402d845` already has the same four-file config map. No tracked improvement-file history was found.

Thus the normal GitOps configuration never provisions Che's nightly opt-in; that is a concrete missing configuration path, not merely an inference from a default. BUT the whole home is persistent: an improvement.yaml could have been created there separately. Its contents and running scheduler were NOT inspected (no other private homes/chats/secrets accessed). Cannot certify Che's actual current runtime is disabled, or infer the human reason why the opt-in was omitted.

### Randy Waterhouse

Registry maps to `harness/agent-randy-waterhouse`. Normal read-only clone failed authentication (`could not read Username`). No repository contents, policy or historical reason verified. Cannot truthfully say Randy is disabled or why. No authentication workarounds or private-home inspection attempted.

### Shared controller facts (not per-agent runtime evidence)

Core `src/improvement.ts`: missing home improvement.yaml resolves to default `enabled:false`; `start()` returns when disabled; enabled start installs start/end and bounded recovery Cron jobs and catches up only within the window. Destination is `policy.reportTo ?? harness.home`; no destination means local archive, not disabled experimentation. Evaluator configuration is required for infrastructure-pinned measurement calls, NOT for ordinary local experiments. Therefore absence of an evaluator is not an explanation for missing nightly work. Neither agent was enabled, redeployed or otherwise changed.

Operator-ready short answer: „Bei Che fehlt die Nachtarbeits-Konfiguration im regulären GitOps-Setup schon seit dessen Einführung. Ob sie später separat im persistenten Home angelegt wurde, habe ich nicht geprüft. Bei Randy konnte ich das Konfigurationsrepository nicht lesen; einen Grund zu behaupten wäre geraten. Der optionale Evaluator ist jedenfalls keine Voraussetzung für lokale Versuche. Ich habe bei beiden nichts umgestellt.“
