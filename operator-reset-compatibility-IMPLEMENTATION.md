# Operator reset compatibility — Implementierung / Übergabe

## Exakter Stand

- Worktree: `/home/node/work/operator-reset-compatibility`
- Branch: `fix/operator-reset-compatibility`
- Frisches Main als Basis: `6fcc2b4a41d66f703acb7d9f364cc13ab2b13d44` (PR161-Nachkorrektur).
- Implementierungs-Commit: `f2a06df00df75ff713b6e6b9fe99577740529b28`
- Implementierungs-Tree: `1eb8d68877ece696fdc64d05e93aaef28c405d43`
- Dieser Übergabetext folgt als separater Commit; der obige Tree bezeichnet exakt Code, Tests und Produktdokumentation ohne diesen Text.
- Dedizierte Git-Identität: Severus Snape <severus-snape@vanillacore.net>.
- Fremde Änderungen im ursprünglichen `/home/node/work/core` nicht verändert.

## Ergebnis und Grenzen

`reset` und das neue atomare `reset-resume` akzeptieren zusätzlich ausschließlich aktive Legacy-Checkpoints mit depth exakt 20 und fehlenden termination/explicitBlocked/recoveryAssessment/recoveryRetry. Keine nachträgliche Klassifikation einer Legacy-Blockierung anhand von Tiefe oder Text. Unklassifizierte blocked-Checkpoints bleiben abgelehnt, auch mit explicitBlocked=false. Explizite Blockierung bleibt abgelehnt.

`reset-resume` durchläuft dieselbe authentifizierte Command-Ingress-Prüfung, Tokenprüfung, Request-Deduplication, Idle-/Pause-/Stop-/Fristprüfung und atomare Persistenz wie die bisherigen Controls. Es speichert den aktiven Zustand mit Audit-Receipt in einer Transaktion. Erst anschließend darf normale Recovery arbeiten. Reset-only bleibt blocked. Review-Budget, Permissions, IDs bisheriger Effekte und waitChecks werden nicht zurückgesetzt.

Host-Budgethinweis enthält gekürzten Originalauftrag, gespeicherten nächsten Schritt oder explizites Unbekannt, Grund (20 Fortsetzungsschritte), authentifizierte Bedienoberfläche und konkrete inspect/reset-resume-Kommandos mit Session/Task. Auch aktive erschöpfte Legacy-Checkpoints erhalten beim Tick den dauerhaften, einmaligen Hinweis. Bereits gespeicherte/zugestellte alte Hinweise werden nicht umgeschrieben oder erneut gesendet.

Der gemeldete Live-Task `task$I4m7BfKpYSm9AOoTFO-pPrOX4TGS3tqeTvQADmJH7Qw` in `sessionmatrix:!RUGuCCwoREYkXCGnYW:samaschke.de` wurde NICHT gelesen oder verändert. Die vom Operator gemeldete Form (active/depth20/fehlende Klassifikation) wird mit isolierten Fixtures reproduziert. Die zusätzlichen Legacy-Sicherheitsbedingungen müssen bei tatsächlicher Bedienung erfüllt sein; unbekannte Live-Felder werden hier nicht behauptet.

Nach Integration/Aktivierung beginnt die authentifizierte Bedienung mit:

```
/task-budget inspect sessionmatrix:!RUGuCCwoREYkXCGnYW:samaschke.de task$I4m7BfKpYSm9AOoTFO-pPrOX4TGS3tqeTvQADmJH7Qw
/task-budget reset-resume sessionmatrix:!RUGuCCwoREYkXCGnYW:samaschke.de task$I4m7BfKpYSm9AOoTFO-pPrOX4TGS3tqeTvQADmJH7Qw <inspect-token> <unique-request-id>
```

Token aus aktueller Inspection einsetzen, neue eindeutige Request-ID wählen. Nicht als Shell-Befehl ausführen. Ein Modell kann diese Slash-Kommandos nicht durch Ausgeben authentifizieren. Natürlichsprachige Reset-Bitte ist weiterhin keine Command-Ingress-Transaktion. Keine Actor-/Source-Fälschung und kein Modell-Selbstreset implementiert.

## Nachweise

Lokale Logs liegen unter `development-evidence/operator-reset-compatibility/` (durch Repository-Regeln ignoriert, keine Voraussetzung für die Tests):

- `operator-reset-baseline.log`: neue Regressionen auf unverändertem Main; aktive Legacy-Reset-Kompatibilität scheitert (20 statt 0), lesbarer Hinweis scheitert; separates blocked-Legacy-Negativ bleibt erfolgreich. Initialer Notice-Test zeigte zugleich, dass active Legacy noch gar nicht benachrichtigt wurde.
- `operator-reset-final-tests.log`: 28/28 erfolgreich mit `node --import tsx --test test/operator-task-budget.test.ts test/budget-attention.test.ts test/wait-notification-integration.test.ts test/task-recovery.test.ts`.
- Enthalten: kombinierte authentifizierte Ingress-Aufnahme mit tatsächlicher anschließender Recovery; atomarer Save-Fehler-Rollback; gleiche Receipt/Request bei Wiederholung; Legacy-blocked-Negativfälle; Stop/Completed/Frist/Explizitblock/abgelehnte Sources; weiterhin monotone Wait-Identität und unveränderte Scope; produktive echte Schritt-20- und Recovery-Budget-Regressionen.
- `operator-reset-build.log`: `npm run build` erfolgreich, inklusive Materialisierung und TypeScript.
- `git diff --check` erfolgreich vor Implementierungscommit.
- Vollsuite `npm test`: nach 240 Sekunden abgebrochen, kein Gesamt-Pass behauptet. Zwei sichtbare Fehler unabhängig nachgestellt (`operator-reset-independent.log`): cron-follow-through expliziter Report (`undefined.prompts`), dedicated-review-integration (`pending` statt `passed`).
- Dieselben zwei Tests auf separat exportiertem unverändertem Main `6fcc2b4` erneut fehlgeschlagen (`operator-reset-main-independent.log`); dort zusätzlich ein zeitabhängiger Cron-Worker-Fehler (`waiting` statt `completed`). Kein fremder Report-/Review-Code verändert. Ein spezifischer weiterer Worker-Bericht war nicht Teil der bereitgestellten Task-Daten; keine unbesehene Bestätigung behauptet.

## Übergabe / Nicht ausgeführt

Kein Live-Reset, keine Änderung von Live-Home oder State, kein Push, PR, Merge, Deployment oder Neustart, keine Delegation. Nur vorgeschriebenen Review-Status inspiziert: bestehender fremder Fingerprint `cbeaa734eece60e9ea0e688449dec3aa02bb01f0cdf7fa4eb8b5ef1466da9937`, 3 Runden, 0 offene Blocker; KEIN Review dieses Trees und kein Budgetreset. Owner muss den exakten Kandidaten regulär reviewen, integrieren und ausrollen. Source-Commit aktiviert nichts in 0.1.110.
