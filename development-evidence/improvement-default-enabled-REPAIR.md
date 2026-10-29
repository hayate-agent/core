# Improvement default-enabled — Reparatur / Parent-Handoff

## Umfang und Befund

Explizite Operator-Korrektur: Selbstverbesserung generell standardmäßig aktivieren,
`enabled: false` als ausdrücklichen Opt-out erhalten. Keine Veröffentlichung,
kein Deployment, keine Live-Konfigurationsänderung, kein Neustart, kein Nacht-/Budgetreset.

Neue isolierte Worktree: `/home/node/work/improvement-default-enabled`, Branch
`fix/improvement-default-enabled`. Frisch gefetchte Basis:
`e4ebb7bbd622016aabaf646130e0ddb87be43337` (origin/main bei Arbeitsbeginn).
Die schmutzige `/home/node/work/core` wurde weder editiert noch bereinigt.
Packaged development guide vollständig gelesen; packaged und aktuelle
`docs/improvement.md` sowie Controller, vorhandene Tests und installierter
`/opt/vanillacore-harness/dist/improvement.js` geprüft. Installierter Controller
verwendet tatsächlich `enabled: false`, auch im ENOENT-Fallback über
`improvementPolicy({ timezone: this.timezone })`.

## Änderung

Einziger produktiver Code-Unterschied: `improvementPolicy`-Default false → true.
Der bestehende Missing-file-Fallback übernimmt denselben Default; keine zweite
Sonderlogik. Explizites false überschreibt ihn weiterhin. Keine Änderung an
Strategieauswahl, Ledger, Historien, Raw-Reports, Reporter, Review-/Evaluatorcode,
Opt-in für Reviewer, Kontextkorrekturen, PR-/Merge-Berechtigungen.

Unverändert: 23–05 Uhr, Harness-Zeitzone/UTC-Fallback, 20 Default-Turns,
pullRequest=false, merge=false, kein Evaluator, kein Reportziel. Konfigurierte
Nachtstrategie bleibt Voraussetzung. Reports gehen nur an reportTo oder das
bestehende Harness-home-Ziel, sonst lokale Datei; kein Broadcast.
Default-enabled ist ausdrücklich KEINE automatische Merge-Freigabe.

## Konkrete Wirkung pro Agent (begrenzter read-only GitOps-Audit)

- **severus-snape**: eigene tatsächliche improvement.yaml gelesen:
  enabled=true, Europe/Berlin 23–05, maxTurns=200, bestehende explizite PR-/Merge-
  Policy; kein Evaluator. Diese Werte wurden NICHT verändert. Defaultwechsel
  hat auf diese Policy keinen Aktivierungseffekt und startet die Nacht nicht neu.
  Sichtbare GitOps-Config `/home/node/work/release-agent-severus`, Revision
  `976f9ea22d0fc60ed288049f0092327495efea1c`, liefert über ConfigMap noch kein
  improvement.yaml. Ein späterer Normal-Konfigurations-PR müsste die bestehende
  autorisierte Policy bewusst abbilden; nicht durch diesen Codepatch ersetzen.
- **che-guevara**: vorhandene Git-Leseberechtigung genutzt, nur sichtbares GitOps-
  Repo in `/tmp/improvement-default-audit/che` gelesen, Revision
  `15c2cdaaa4e7d1061f0be29c3e4665760f9815ca`. Kein versioniertes improvement.yaml,
  kein entsprechender ConfigMap-Eintrag/Mount: **GitOps-Policy fehlt**, nicht
  nachgewiesen explizit deaktiviert. Nach normalem Image-Rollout greift der neue
  Default nur, wenn auch im privaten persistenten Home keine explizite Policy
  liegt und die Strategie konfiguriert ist. Home/Secrets wurden nicht gelesen.
  Keine Aussage über tatsächliche Live-Aktivierung möglich.
- **randy-waterhouse**: aktuelle sichtbare Overlay-Registry identifiziert den
  zweiten anderen Agenten (`harness/agent-randy-waterhouse`). Read-only Git-Clone
  mit vorhandener Identität scheiterte: Username konnte nicht gelesen werden.
  Kein neuer Zugang beschafft. **Policy unbekannt**, weder fehlend noch false
  behauptbar. Repo-Verantwortlicher muss im normalen Konfigurationsweg prüfen.

Registryquelle: read-only Clone `/tmp/improvement-default-audit/overlays`, HEAD
`0ea198a376401e0ec6edcd772374fd06c61455a2`, agents.json enthält genau severus-snape,
che-guevara, randy-waterhouse. Lokaler älterer release-overlays-Checkout kennt nur
zwei Agenten und wurde daher nicht als aktuelle Vollständigkeitsquelle benutzt.
Jedes tatsächlich vorhandene explizite false bleibt unangetastet; Klärung durch
Operator/Repo-Verantwortlichen statt stiller Zwangsaktivierung.

## Koordination mit bestehendem Worker

Dispatcher-Statuswerkzeug verweigert in diesem delegierten Kontext Orchestrierung.
Daher nur vorhandene executions.json read-only selektiv ausgewertet:
`f907dad5-4d6d-420a-b2cf-e3d0a4cb2859`, Request
`human-night-report-and-agent-enablement-audit-v1`: zunächst running, beim finalen
read-only Recheck **completed**. Tatsächliches Worker-Ergebnis gelesen: 14/14
gezielte Tests; Core staged Tree `002cffc6b2c2c6319c2e040d02e0a71c510f9264`,
Plugins staged Tree `fa88d309f3fc278011cc18577491f9cce682bfda`; keine Publikation.
Evidenz: `/home/node/work/human-night-report/development-evidence/human-night-report-REPAIR.md`.
Worktree `/home/node/work/human-night-report` auf gleicher Basis enthält laufende
Renderer-/Reporttest-Änderungen. Nicht editiert, nicht kopiert, keine Nested Agents.
Eigener Patch berührt keinen Reporter und keine seiner Reporttest-Dateien.
Parent kann beide Kandidaten kombinieren, muss dann aber den NEUEN exakten
Kombinationsbaum unabhängig reviewen und testen.

## Verifikation

Logs: `development-evidence/improvement-default-enabled/` (lokale Artefakte,
separater SHA256-Manifest-Handoff; nicht Bestandteil des Codepatches).

- `node --import tsx --test test/improvement*.test.ts`: **15/15 bestanden**.
- `npm run typecheck`: bestanden.
- `npm run build`: bestanden; kein laufendes Deployment geändert.
- Neue Integrationstests: fehlende Datei; Datei ohne enabled; explizit false;
  lokale Zeitzone/Nachtgrenze/DST; keine Arbeit außerhalb Fenster; Budget und
  3-Turn-No-experiment-Stop; Restart ohne Ledgerreset; lokaler Report ohne
  Broadcast trotz registriertem Channel; keine erfundenen Receipts/Evaluator;
  Evaluatorzugriff außerhalb aktiver Session/Fenster verweigert.
- Vorhandene Reportziel-/Budget-/Receipt-Tests laufen unverändert mit.
- Vollsuite: **873 Tests, 870 bestanden, 3 fehlgeschlagen**:
  cron-follow-through (Archivkontext), dedicated-review-integration, TUI-Session-
  Isolation. TUI einzeln ebenfalls fehlgeschlagen. Nicht als grün ausgegeben.
- Separater unveränderter Baseline-Worktree
  `/home/node/work/improvement-default-baseline` auf obigem Basiscommit:
  dieselben drei betroffenen Testdateien ausgeführt, 18 Tests, 14 bestanden,
  4 fehlgeschlagen; alle drei Kandidatfehler reproduziert, zusätzlich ein
  scheduled-worker-Test. Diese Fehler bestehen somit bereits auf der Basis;
  keine Reparatur außerhalb des beauftragten Minimalumfangs vorgenommen.

## Review und normale Auslieferung

Keine Branch-Publikation, kein PR, Merge oder Deployment vor Parent-Review.
`plugin_review status` zeigt den bestehenden Core-Recovery-Changeset-Fingerprint
`cbeaa734eece60e9ea0e688449dec3aa02bb01f0cdf7fa4eb8b5ef1466da9937`,
3 verbrauchte Runden, Status escalated, keine offenen P0/P1. Das ist ausdrücklich
NICHT das Review dieses isolierten Kandidaten. Tool kann hier keinen Worktree
adressieren; kein Reset/Sessionwechsel zur Budgetumgehung. Parent muss den exakten
Kandidaten separat unabhängig prüfen; offene P0/P1 blockieren weitere Lieferung.
Manifest nennt Commit/Base/Tree und Hashes. Erst danach normaler Core-PR,
Review/Merge/CI/Image/GitOps-Rollout. Agentkonfigurationen separat durch normale
Repo-Verantwortliche liefern; keine fremden Projekte übernehmen und keinen
Evaluator oder Mergezugang erfinden.

## Menschlicher Nachtbericht jetzt (retained state, nicht Deploymentbeweis)

Vorhandenes Raw-Report `improvement/reports/2026-10-28.json` read-only gezählt:
**54 Turns, 52 protokollierte Experimente: 45 improved, 4 rejected,
3 inconclusive.** Das sind gemeldete Experimentresultate, keine unabhängig
verifizierten Adoptionen. Weder diese Zahlen noch ein Build belegen Deployment.
Der andere Worker liefert die menschliche Darstellung; Parent kann diese
verifizierten Bestandszahlen sofort für seine Antwort verwenden.
