# Lesbarer Nachtbericht: Plugin geliefert, Core wartet auf Review

## Was veröffentlicht wurde

- Plugin-PR: https://git.vanillacore.net/harness/plugins/pulls/28
- Branch: `fix/human-night-report`; Autor/Committer: Severus Snape <severus-snape@agents.vanillacore.net>; authentifizierter Forgejo-Account `severus-snape`.
- Commit: `042b6f9530a77ec929740543b07ba36b41c5be85`.
- Basis: `56082f1bb0c03513b920a722b2e3cd2fdbfcd0cd`.
- Exakt unabhängig geprüfter Baum: `fa88d309f3fc278011cc18577491f9cce682bfda`.
- Full-index/Binary-Patch SHA256: `b144c985516b27f4fb552bcabf3215b1fe8fd2e489d6c9d50ba06d1e167a4bc2`.
- Regulärer geschützter PR-Merge: `1600a618e6284c3274ceb95f5d92ba28cd08b8aa`, 2026-10-29 05:33:10 UTC. Auch der Merge-Baum ist exakt `fa88d309f3fc278011cc18577491f9cce682bfda`; `git diff HEAD origin/main -- src` leer.
- Vor Veröffentlichung war Remote-main unverändert auf der geprüften Basis. Keine Übertragung des alten Baums auf neue Upstream-Implementierung. Kein Force-Push, kein direkter Main-Push, kein Schutz-Bypass.
- Branchschutz per API: protected=true, user_can_push=false, user_can_merge=true, required_approvals=0, enable_status_check=false. Commit-Statusliste leer (0 Checks); kein eigenständiger Plugin-Testlauf und kein erfundener Plugin-PASS. PR war mergeable=true. Codegrundlage ist unabhängiges Exact-Tree-Review `655b56e9`, ohne bestätigte P0/P1.

## Abgleich mit paralleler Arbeit

Vor Veröffentlichung: keine passenden Remote-Branches und keine offenen Human-Report-/Default-Enable-PRs; Plugin-main `56082f1`, Core-main `e4ebb7bbd622016aabaf646130e0ddb87be43337`. Offener Core-PR #143 betrifft andere Arbeit. Dispatcher-status ist in diesem Worker gesperrt; deshalb vorhandene lokale Execution-Metadaten nur lesend abgeglichen, keine Worker gestartet oder verändert: `49a606ab` ist diese Lieferung; `13ef28d7` prüft Default-Enable unabhängig; `ee2f9338` prüft den Atomic-Usage-Nachtvorschlag. Keine zweite Report-Lieferung beobachtet.

Default-Enable-Worker `9b0fed56` ist abgeschlossen, Kandidat `09ed786a9b200098766539531244350560704792`, Baum `3d87cb4e7da4c8905a644bc100d3344a663445a8`, Basis ebenfalls `e4ebb7bb`. Sein Manifest nennt src/improvement.ts, Dokumentation, Tests und Repair-Evidence, keinen Plugin-/Core-Lock. Sein unabhängiges Review läuft separat. Nicht kombiniert, überschrieben oder veröffentlicht. Der Parent kann später kombinieren, muss dann aber die vollständige Kombination erneut exakt prüfen lassen; fremde Testergebnisse gelten nicht automatisch für diese Kombination. Vor jeder Core-Veröffentlichung Remote-main erneut abgleichen.

## Neuer Core-Kandidat — noch NICHT veröffentlichen

Arbeitsbaum `/home/node/work/human-night-report`, Branch `fix/human-night-report`, Basis `e4ebb7bbd622016aabaf646130e0ddb87be43337`. Ursprünglicher geprüfter Baum `002cffc6b2c2c6319c2e040d02e0a71c510f9264`, Patch SHA256 `868837c10c4da94f5043f44b8eabf0ca632c60b22e782157815c70abd2c79211`, vor Änderungen bestätigt.

Neue Bytes gegenüber diesem Review: nur `plugins.lock.json` (Revision und Renderer-Digest) sowie diese Übergabe. Keine P2-Bereinigung: vorhandene Repair-Evidence, lokaler Entwicklungslock und Fixture bleiben unverändert, um unnötige neue Bytes zu vermeiden. Der lokale Lock bleibt bloß historische Entwicklungshilfe; alle folgenden Läufe nutzten den Produktionslock, ohne lokale Source-/Lock-Argumente.

Produktionsrevision `1600a618e6284c3274ceb95f5d92ba28cd08b8aa`; SHA256 von `src/improvement-report.ts`, mit sha256sum gemessen: `2e206939ef70e86df87059a5ab5584b203dec1decf289e437642e163d630b273`. Alle übrigen Lock-Digests unverändert. Unterstützter Materializer `npm run plugins:materialize` lädt die gepinnte Remote-Revision und verifiziert sämtliche Dateien, bevor er generierte Quellen ersetzt. Generierte Dateien nicht bearbeitet oder gestaged.

Die exakte finale Identität einschließlich dieser Datei steht extern in `/home/node/.vanillacore-harness/development-evidence/human-night-report-production/manifest.json` (Basis, staged tree, Full-index-Patchhash, alle geänderten Dateien mit SHA256, Loghashes). Der zugehörige vollständige Patch liegt daneben als `candidate.patch`. Externe Identität vermeidet einen selbstreferenziellen Hash in der zu hashenden Datei. Kein Core-Commit, Push oder PR in dieser Lieferung. Frisches unabhängiges Review des kompletten finalen Baums einschließlich Produktionslock und Pluginrevision ist zwingend vor Core-Veröffentlichung.

## Tatsächlich ausgeführte Prüfungen

Logs: `/home/node/.vanillacore-harness/development-evidence/human-night-report-production/`.

- `npm run plugins:materialize`: Exit 0, Remote-Produktionslock.
- `timeout --kill-after=5s 90s node --import tsx --test test/improvement-report.test.ts test/improvement-local-report.test.ts test/improvement.test.ts test/improvement-experiments.test.ts`: Exit 0, 14/14 bestanden, 0 Fehler, 0 abgebrochen, 9.842 Sekunden.
- `timeout --kill-after=5s 90s npm run typecheck`: Exit 0, inklusive normalem pretypecheck-Materializer.
- `timeout --kill-after=5s 90s npm run build`: Exit 0, inklusive normalem prebuild-Materializer.
- `timeout --kill-after=5s 180s npm test`: Exit 124. Zusammenfassung 495 Tests, 398 bestanden, 2 fehlgeschlagen, 95 abgebrochen. KEIN PASS.
- Konkrete Fehler: `test/cron-follow-through.test.ts:32` (undefined.prompts), `test/dedicated-review-integration.test.ts:27` (actual pending statt expected passed). Sie traten auch im vorherigen unabhängigen Lauf auf; das beweist keine Baseline-Ursache. Weitere Tests wurden bei Timeout abgebrochen. Fehler/Abbrüche bleiben offen und müssen im neuen unabhängigen Review bewertet werden. Sie wurden nicht behoben, als vorbestehend erklärt oder zu bestanden umbenannt.
- `plugin_review status`: bleibt an den fremden schmutzigen Standard-Core gebunden, Fingerprint `cbeaa734eece60e9ea0e688449dec3aa02bb01f0cdf7fa4eb8b5ef1466da9937`, drei Runden. Kein falsches `run`, keine Budget-/Ledger-Änderung, kein Kandidaten-PASS daraus abgeleitet. Parent muss den finalen Kandidaten separat exakt prüfen lassen.

## Was unverändert bleibt

Maschinenarchive, Historie, Reviewer-off/Opt-in, Kontextkorrekturen, Agentenkonfigurationen und Laufzeit bleiben unangetastet. Der menschenlesbare Bericht verliert rohe JSON-Blöcke und den unerwünschten Schlusssatz; der Datennachweis bleibt erhalten. Kein Default-Enabling, kein Hotpatch, keine anderen Agenten übernommen.

Der Plugin-Merge aktiviert noch nichts. Erst nach frischem Core-Review, normaler Core-PR/CI/Release und später verifiziertem GitOps-Rollout darf eine Aktivierung behauptet werden. Diese Lieferung enthält keinen solchen Nachweis.
