# Odo: Dispatcher-Schleifen und interne Chat-Ausgaben

Stand: 2026-11-13. Read-only Untersuchung des laufenden Deployments `agentos-saastaq/hayate-odo`, Container `harness`, und Core `d08da97` (0.1.300). Kein Deployment-/Aufgabenstatus verändert. Keine Credentials oder vollständigen Worker-Transkripte exportiert.

Workspace: `.worktrees/odo-dispatcher-loops`, Branch `fix/odo-dispatcher-loops-and-noise`.

## Live-Belege

Aus executions.json selektiv per Node nur IDs und Steuerungsmetadaten ausgegeben:

- `e1937d4f-6321-4b5a-863a-cdadcdd7b42f`: paused/runtime-failure; assessmentHold blocked, Schrittindex 1; workerRetry attempts 11; correction rounds 19; assessment attempts 9; 1/4 Schritte abgeschlossen.
- `1af3ca55-57c8-4520-881a-b2d3b4bb30a0`: paused/runtime-failure; assessmentHold blocked, Schrittindex 1; workerRetry attempts 5; correction rounds 3; assessment attempts 4; 1/2 Schritte abgeschlossen.
- `8156d363-2c24-40f5-aef6-896938a14d64`: paused/retry-exhausted; assessmentHold blocked, Schrittindex 0; correction rounds 4, reportOnly true; assessment attempts 12; 0/1 Schritte abgeschlossen.
- `ceeaec1b-6bfa-4568-90e2-9b511bec4231`: ready; correction rounds 4; progress stalls 3; assessment.nextAt gesetzt; 0/1 Schritte abgeschlossen.
- Pod-Logs zeigen fortlaufend dieselben externen Blockaden für Schritt 1/2, einschließlich haiku und sonnet.
- Zum Messzeitpunkt 10 paused, 1 blocked, 5 ready, 2 running, 124 completed und 5 cancelled Ausführungen.

Mehrere neue Ausführungen gehören zu denselben Parent-Aufgaben, trotz bereits abgeschlossener Kind-Ausführungen. Beispiele:

- Parent `715b7a5a-7483-4b9a-8d91-68bc61821146`: eaaeea01 completed, e674e7ca completed, d408488c running. Parent active, depth 134, waitChecks 14.
- Ticket-Review-Parent (ID-Präfix `$thDUrw`): 09b172da completed und 050c3f79 completed; Parent weiterhin active, depth 21.
- Cron-/Ticket-Parent (ID-Präfix `$oPZ6KX`): 4d3c0483 completed, 79725542 completed, a499ef1f ready; Parent active, depth 5.

Das beweist mehrere Orchestrierungsebenen. Ein Kindabschluss schließt den Parent nicht automatisch ab. Ob die einzelnen Kindaufträge inhaltlich redundant sind, muss gesondert gegen ihre konkreten Mandate geprüft werden.

## Codebefunde

1. `src/dispatcher-sequential.ts:534ff`: Validator-continue-Schleife ohne Rundenobergrenze. Fehlender Fortschritt führt zu deferAssessment/Backoff, nicht zu einer fachlichen Endentscheidung. `progress` dokumentiert ausdrücklich „paced, never terminalized by their count“. Neue erfolgreiche Tool-Ergebnis-Receipts setzen stalls zurück; sie sind kein Beweis für tatsächliche Zielerreichung.
2. `src/assessment-retry.ts`: Backoff 1 Minute bis 1 Stunde, explizit ohne Versuchslimit. Das ist ein anderer Mechanismus als das 12er Worker-Recovery-Budget.
3. `src/dispatcher.ts:333ff`: ExecutionAssessmentHold wird als runtime-failure an ExecutionStore.fail weitergegeben, mit zusätzlichem assessmentHold. `src/execution.ts:895ff` plant darauf automatische Worker-Recovery. Damit verbraucht eine fachliche externe Blockade das technische Recovery-Budget, bis retry-exhausted erscheint.
4. `src/cli.ts:817ff`: Plan, Validator-Fortsetzungen und Schrittabschlüsse werden über eventText zum Benutzerziel geroutet. Routine wird zwar als Statuszeile markiert, aber nicht grundsätzlich aus dem Chat herausgehalten. Die Sonderbehandlung für Cron greift nur bei Parent-Präfix cron-followup:, nicht generell für Cron-/automatische Fortsetzungen. Die untersuchten konkreten Ausführungen besitzen Matrix-Parents; ein pauschaler cron:-Filter würde sie nicht abdecken.
5. `src/dispatcher-runtime.ts:28ff`: eventText enthält interne Planbegründungen, Rollen/Modelle und Validatorrunden unverändert. Ein Status-Edit ist daher noch keine Trennung interner Telemetrie von fachlicher Benutzerkommunikation.
6. Parent-Continuation läuft zusätzlich im Harness (z.B. source cron für Task-Fortsetzungen). Lokales Retry-Limit einer Kind-Ausführung begrenzt nicht die Zahl neuer Kind-Ausführungen unter demselben Auftrag.

## Reparaturleitplanken (noch nicht implementiert)

- Interne Plan-/Routing-/Validator-Telemetrie standardmäßig nur in Inspektion/Activity; Benutzerkanal erhält fachliche Ergebnisse, echte Rückfragen und neue handlungsrelevante Blockaden. Auch unveränderte Status-Edits nicht mit internen Begründungen füllen.
- Technische Fehler, korrigierbare Evidenzlücken und echte externe Wartebedingungen als getrennte Zustände behandeln. Externe Blockade darf nicht als Transportfehler das Worker-Retry-Budget aufbrauchen.
- Unveränderte Evidenz/Validatorforderung nicht endlos neu bearbeiten: aufgabenbezogene Stagnations-/Zyklusprüfung über Worker-, Assessment- und Parent-Grenzen. Niemals fehlende Evidenz als Erfolg deklarieren.
- Bei Warten auf neue Information ereignisgesteuert bzw. mit sinnvoller fachlicher Prüfung weiterarbeiten, ohne erneute Worker-Arbeit allein durch den Ablauf eines technischen Backoffs.
- Parent-Reconciliation prüfen: abgeschlossene oder ausdrücklich gestoppte Effekte nicht als neue Kindaufträge wieder auflegen; legitime fortlaufende Monitoring-Aufträge dabei erhalten.
- Regressionen: gleicher Blocker mehrfach, Validator-continue ohne neue Evidenz, Restart mit unverändertem Hold, neue Kind-ID unter gleichem Parent, Matrix-Parent mit automatischer Fortsetzung sowie keine Plan-/Modellbegründung im Benutzerkanal. Echte Rückfragen/Ergebnislieferung dürfen nicht verloren gehen.

## Grenzen

Keine fachliche Prüfung aller Worker-Mandate/Registrierungsantworten vorgenommen. HTTP-400-Ursache und Erfolg einer neuen Registrierung damit nicht zusätzlich belegt. Keine Quellcodeänderung oder Tests ausgeführt; dies ist eine Diagnose, kein ausgelieferter Fix.
