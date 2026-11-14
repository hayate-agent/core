# Operatorgeführtes, sessionunabhängiges Auftragsbuch

Status: Architekturvertrag mit erster lokaler Core-Implementierung; noch nicht ausgerollt. Implementierter Umfang und verbleibende Integrationen: `docs/task-lifecycle.md`.

## Problem und belegte Ursachen

Untersuchung von Odo und Peter am 2026-11-14:

- Odo (installiert Core 0.1.315): Ein einzelner Read-only-Dispatcherauftrag erhielt im untersuchten Morgenfenster 107 Validator-Korrekturen. Neue Beobachtungszeiten und Journalzustände lieferten immer wieder andere Tool-Ergebnisse, ohne die zugrunde liegende Nachweislücke zu lösen.
- Peter: Seit 07:00 UTC wurden im untersuchten Haupttranskript 185 automatische `Resume ... after an interruption`-Eingaben gefunden. Mehrere ursprüngliche Aufträge vom 11./12. November waren weiterhin aktiv; kurze Operator-Fortsetzungen wie `Weiter` existieren als eigene Mandate neben ihren Ursprungsthemen.
- `Harness.resultMandate()` akzeptiert bisher auch `completed`-Parents. Die Turn-Finalisierung lässt deren Wiederöffnung zu, wenn ein späteres Worker-Ergebnis eine neue Antwort hervorbringt. Ein lokaler Regressionstest reproduziert die erneute Prüfung und den erzeugten Folgeturn.
- `accountRepetition()` berechnet bei `normal` keine Stagnation: Ein toolfreies unabhängiges `continue` kann unveränderte Arbeit unbegrenzt fortsetzen. Dispatcher-Metadaten zählen zusätzlich als Tool-Fortschrittsbelege.
- Die technische Supervisorentscheidung ist bisher zugleich der wesentliche fachliche Lebenszyklus. Eine unabhängige dauerhafte Operatorentscheidung, das Thema zu beenden, fehlt. Mehrere überlappende Aufgaben derselben Absicht werden separat wieder geprüft.

Die lokalen Quellkorrekturen wurden um einen ersten agentenweiten Core-Auftragslebenszyklus ergänzt. Die Vertragskonflikte zwischen unabhängiger Parent-Arbeit und technischem Abschluss sind differenziert aufgelöst: laufende/queued Kinder halten den Parent wartend; erhaltene blockierte Kinder erzwingen keine Wiederöffnung eines abgeschlossenen Parents. Vollständiger lokaler Testlauf nach Rebase und Review-Korrekturen: 2.534 Tests, 2.533 bestanden, 0 fehlgeschlagen, 1 übersprungen. Fünf konkrete Reviewbefunde wurden korrigiert und gezielt nachgeprüft. Noch kein Produktivstatus wurde verändert; der gesamte Entwurf ist damit nicht bereits vollständig ausgeliefert.

## Architekturentscheidung: Core, nicht Dispatcher-Plugin

Der Auftragslebenszyklus, Operatorstatus und optionale Plan gehören in den Core und gelten auch ohne Dispatcher. Dispatcher sind ausführende Adapter für direkte/sequenzielle/pluginbasierte Strategien; Validatoren und Planner liefern beratende Vorschläge. Kein Plugin besitzt die Autorität, einen operatorseitig erledigten Auftrag wieder zu öffnen.

Vorgeschlagene Core-Grenzen (neue Module, keine bereits vorhandenen APIs):

- **TaskLedger**: agentenweite stabile Auftrags-ID, Operatorstatus, technische Outcomes, Generation/Revision, unveränderte Request-/Klarstellungsquellen, optionaler Plan und append-only Entscheidungs-/Outcome-Receipts. Sessions enthalten Referenzen, nicht getrennte Authority-Kopien. Bestehende Task-/Execution-Speicherung wird kontrolliert darauf migriert; kein zweiter Scheduler oder konkurrierender Taskbestand.
- **TaskLifecycle**: einzige Zustandsübergangslogik für Abschluss, Inaktivitätsdisposition, explizite Neueröffnung, revisionsgebundene Outcomeübernahme und Planänderungen. Semantische Modelle schlagen Intent-Zuordnungen vor; der Host bindet sie an authentische Quellen und übernimmt nur valide Übergänge.
- **Admission/Tool-Gates im Harness**: Task-ID und Generation vor Main-/Worker-Ausführung und effektbehafteten Tools prüfen; geschlossene oder überholte Generationen nicht ausführen. Technische Prüfer können diese Sperre nicht überstimmen.
- **Outcome-Verarbeitung am Host-Turn-Commit**: einheitlicher dauerhafter Effekt-/Ergebnisbeleg für Main, Dispatcher und Subagents; idempotente Planänderungen erst nach Commit. Keine ausschließliche Kopplung an Dispatcher-Step-Events.
- **TaskPresentation**: Main-/Kanalansicht wird aus genau dem gespeicherten Plan gerendert; fachliche Änderungen bündeln, interne Telemetrie getrennt halten.

Erweiterbar bleiben Planerzeugung, semantische Intent-Erkennung, Recherchevorschläge, Skill-Check und technische Validator-Provider. Sie erhalten einen begrenzten auftragsgebundenen Kontext und liefern Vorschläge mit Quellen-/Outcome-Bezug, keine direkten Ledger-Schreibrechte oder Ausführungsgenehmigungen. Core-Persistenz und Lifecycle-Gates funktionieren auch bei deaktiviertem/ausgefallenem Planner oder Validator; daraus entsteht kein unvalidierter produktiver Fallback.

Es gibt keinen Zwang zum LLM-Aufruf für jeden Eingang: Core stellt die technische Auftragszuordnung und Statusfences bereit, optionale Planung wird nur bei geeigneter Komplexität aktiviert. Ein einzelner Main-Turn kann einen einfachen Auftrag erledigen; er braucht weder Dispatcher noch Todo-Liste.

Inaktivität ist keine technische Erfolgsbehauptung. Sie ist eine operatorseitig konfigurierte Lifecycle-Regel mit eigener Disposition; Daueraufträge, offene freigegebene Arbeiten und Cron-Serien brauchen explizite Behandlung. Authentische Nutzerintention dominiert Modellvorschläge, aber hebt bestehende Zugriffs-, Sicherheits- und externe Freigaberegeln nicht auf.

### Bestehende Pi-Extensions integrieren, kein Parallelprodukt

Bestätigtes bestehendes Repository: `https://git.samaschke.de/pi-agent/extensions`, Paket `pi-agent-extensions`. Die Pi-Integration gehört in diese Sammlung, nicht in ein neu erfundenes separates Extension-Repository.

Die aktuellen Repository-Dokumente beschreiben relevante vorhandene Komponenten:

- `goal`: bestehende Zielverfolgung mit Judge/Fortsetzungen, manueller Erledigung und Pausieren bei Nutzereingaben. Zustand bislang in der Pi-Session, also noch kein sessionunabhängiges Operator-Auftragsbuch.
- `plan-mode`: bewusst lesender Konzept-/Planungsmodus mit Accept/Save/Cancel. Die aktuelle Detaildokumentation schließt Todo-Liste und Fortschrittswidget ausdrücklich aus; dies nicht als bereits vorhandenes Ausführungsledger missverstehen. Der Modus muss nicht für normale Auftragsplanung aktiviert werden.
- `request-router`: bestehende direkte/delegierte Ausführung und begrenzte Worker; bleibt ausführender Adapter, nicht Lifecycle-Owner.
- `fritz-brain`: bestehende Memory-Integration für Research/Ergebnissicherung; Memory ist kein Ersatz für verbindliche Operatorstatus-Persistenz.
- `extensions/shared`: vorhandene Workflow-/Tracker-/Run-/Widget-Bausteine vor Implementierung auf tatsächliche Wiederverwendbarkeit prüfen. Ihre Dateinamen allein belegen noch keinen geeigneten Lifecycle-Vertrag.

Das README nennt `plan-mode` verkürzt noch „optional tracked execution“, während `docs/plan-mode.md` explizit keinen Todo-Workflow beschreibt. Vor Änderungen den tatsächlichen Codevertrag prüfen und diesen Dokumentationswiderspruch berücksichtigen.

Ein zentraler Lifecycle-Owner koordiniert die bestehende Goal-/Workflow-/Router-Integration. Keine zusätzliche Extension, die unabhängig von `goal` oder Workflow-Controllern eigene Judge-/Resume-Schleifen erzeugt. Die gemeinsame hostunabhängige Zustandsmaschine kann Hayate Core und diese Pi-Sammlung bedienen; Paketort und Abhängigkeit werden nach Prüfung der vorhandenen Shared-Bausteine festgelegt.

## 1. Zwei unabhängige Statusachsen

Ein dauerhafter Auftrag besitzt eine stabile agentenweite ID, unabhängig von Session, Unterhaltung und Dispatcher-Ausführung.

- **Operatorstatus**: offen / erledigt. Erledigung ist bindende Disposition des Auftrags, kein behaupteter technischer Erfolg.
- **Technischer Status**: unbekannt / offen / laufend / wartend / blockiert / erfüllt / fehlgeschlagen, mit Nachweisen.

Beispiel: `operator=erledigt`, `technical=blockiert`. Das ist ein zulässiger Endzustand. Validator, Startup, Recovery und verspätete Worker-Ergebnisse dürfen ihn nicht wieder öffnen. Technische Lücken bleiben als historische Fakten sichtbar.

Jeder Operatorabschluss hat einen dauerhaften Receipt mit Grund (explizit, semantisch aus authentischer Operatoräußerung, Inaktivität nach konfigurierter Policy), Quelle, Zeitpunkt und Auftragsrevision. Eine Neueröffnung erhält eine neue Generation und darf nur aus neuer authentischer Operatorautorität oder einer expliziten registrierten Zeit-/Cron-Autorität entstehen. Validatorurteile und Neustarts sind keine Neueröffnungsautorität.

Ein alter Cron oder ein verspätetes Resultat besitzt nicht allein deshalb eine neue Generation. Bei wiederkehrenden Aufträgen werden die einzelne Ausführung und die weiterhin gültige Serienautorisierung getrennt geführt.

## 2. Operatorintention und Inaktivität

Originalrequest und authentische spätere Klarstellungen bleiben als geordnete unveränderte Quellen erhalten. Ein neuer `Weiter`-Turn wird nach semantisch geprüfter Zuordnung als Klarstellung/Neueröffnung desselben Auftrags geführt, nicht automatisch als neues unabhängiges Dauermandat.

Explizite Erledigung oder klare sinngemäße Beendigung hat Vorrang vor technischen Befunden. Semantische Erkennung ist ein Vorschlag; der Host bindet ihre Wirkung an die authentische Operatornachricht, den exakt zugeordneten Auftrag und dessen erwartete Revision. Bei unklarer Zuordnung keine fremden Aufträge schließen.

Inaktivität richtet sich nach echter Operatoraktivität für das Thema, nicht nach Agenten-, Validator-, Tool-, Retry- oder Resume-Aktivität. Die Frist ist eine sichtbare konfigurierbare Policy, keine frei vom Modell erfundene Zahl. Ursprüngliche explizite Dauer-/Zeitaufträge und registrierte Cron-Serien sind in dieser Policy gesondert abzubilden. Ein Inaktivitätsabschluss wird nicht als technischer Erfolg ausgegeben.

## 3. Optionale Todo-Liste

Nur größere, mehrteilige oder länger laufende Aufträge erhalten einen Plan. Triviale Antworten und einfache begrenzte Tasks brauchen kein Planungsritual und keinen zusätzlichen Validator-Durchlauf.

### Recherche ist expliziter Bestandteil des Plans

Bei planpflichtigen Aufträgen gehören auch die Recherche- und Klärungsschritte in die gespeicherte Todo-Liste, nicht nur die Umsetzung:

1. Originalrequest, bestehende Operatorentscheidungen und spätere Klarstellungen zuordnen.
2. **Memory-Research**: vorhandenes Wissen, frühere Entscheidungen, Ergebnisse und bereits erledigte Arbeiten zum Auftrag suchen und abgleichen. Vorhandene belegte Outcomes wiederverwenden statt erneut zu produzieren.
3. **Skill-Research**: relevante vorhandene Skills und ihre Nutzungsvorgaben suchen, auf Eignung prüfen und bei Bedarf laden. Bereits vorhandene Fähigkeiten wiederverwenden; fehlende oder fehlerhafte Skills als konkrete Lücke festhalten.
4. **Quellen-/Bestandsrecherche**: relevante lokale Dateien, Repositories, Dokumentation, bestehende Tickets und Systemzustände gezielt prüfen.
5. **Internet-Research**: erforderliche externe Fakten, aktuelle offizielle Dokumentation und geeignete Lösungsansätze recherchieren. Authentifizierte oder interne Quellen nur im bestehenden Zugriffsscope nutzen; keine privaten Auftragsdaten oder Secrets an externe Suchdienste senden.
6. Erkenntnisse und offene Fragen gegen den ursprünglichen Auftrag plus Klarstellungen abgleichen; daraus begründete nächste Arbeitsschritte ableiten. Falls für den Auftrag erforderlich, Skill-Erstellung oder -Überarbeitung als eigenes Todo aufnehmen.
7. Umsetzung beziehungsweise eigentliche Lieferung und Prüfung als eigene Todos führen.
8. **Abschließender Skill-Check**: bei jedem regulären fachlichen Abschluss eines planpflichtigen Auftrags explizit prüfen, ob die tatsächlichen Outcomes eine Überarbeitung vorhandener Skills oder die Erstellung eines neuen Skills erfordern. Ergebnis und Begründung speichern, auch wenn keine Änderung nötig ist. Diese Pflicht erweitert nicht die Planpflicht auf triviale/einfache Tasks.
9. **Erforderliche Skill-Änderungen umsetzen**: aus dem Skill-Check abgeleitete, vom Auftrag und geltenden Berechtigungen gedeckte Änderungen als konkrete Todos anlegen, ausführen und prüfen. Zuständiges Skill-/Agentenrepository, vorhandene Reviews und reguläre Auslieferungswege berücksichtigen; ein lokales Edit ist noch keine veröffentlichte oder aktivierte Fähigkeit. Nicht gedeckte Änderungen separat als Vorschlag bzw. Freigabebedarf ausweisen.
10. Ergebnisübergabe einschließlich Recherche-, Implementierungs- und Skill-Outcome.

Recherche-Todos besitzen dieselben stabilen IDs, Zustände und Outcome-Receipts wie Umsetzungsschritte. Ein abgeschlossener Rechercheschritt hält Fragestellung, Quellen/Memory-Referenzen, Erkenntnisse, Grenzen und gegebenenfalls einen begründeten Aktualisierungsbedarf fest. Bloßes Suchen oder das Ausführen eines Tools ist noch kein fachlich abgeschlossenes Rechercheergebnis; ein belegter negativer Suchbefund kann dagegen ein gültiges Ergebnis sein.

Eine Recherche wird nicht auf jedem Turn erneut ausgeführt. Wiederöffnung erfordert eine neue relevante Frage, neue Operatoranforderung oder begründete veränderte/abgelaufene Quellenlage; eine weitere Validatorforderung oder ein Restart allein reicht nicht. Wenn eine Quellenklasse für den konkreten Auftrag nicht nötig oder ausdrücklich untersagt ist, wird das im Plan begründet als nicht erforderlich/entfallen ausgewiesen, statt sinnlose Netzwerkzugriffe zu erzeugen. Trivia und einfache Tasks werden dadurch weiterhin nicht planpflichtig.

Für einen geplanten Auftrag:

- stabile Todo-IDs;
- Bezug jedes Todos auf Originalrequest oder Operator-Klarstellung;
- Zustand offen / laufend / wartend / erledigt / entfallen;
- konkrete Outcomes und zugeordnete Worker-/Quellnachweise;
- Herkunft und Revision jeder Ergänzung oder Abnahme;
- verständliche knappe Operatoransicht mit offenen und abgehakten Punkten.

Ergänzungen aus Dispatcher und Validator sind Vorschläge. Typische zulässige Ergänzungen sind ein anhand konkreter Outcomes fehlender Recherche-/Prüfschritt, ein fehlender abschließender Skill-Check sowie eine konkret begründete Skill-Korrektur oder Skill-Erstellung. Der Validator darf solche fachlich notwendigen Restarbeiten nicht nur erwähnen: Der Host übernimmt gedeckte Vorschläge als sichtbare Todos, die anschließend regulär bearbeitet und anhand ihrer Outcomes abgenommen werden. Der Host übernimmt sie nur an einem erfolgreich gespeicherten Turn-Ende/Outcome-Ereignis, idempotent und revisionsgebunden, innerhalb der bestehenden Autorität. Keine Ergänzungen durch bloßes Polling, Restart, Timer-Tick oder wiederholten Validatorwunsch. Neue Operatoranweisungen dürfen den Plan auch zwischen Turns ändern; bereits laufende Worker behalten Ownership- und Effektfences.

Operatorintention hat Vorrang: Abgewählte oder erledigte Punkte dürfen nicht als neue Validator-Todos wiederkehren. Ein Validator darf keinen größeren Auftrag oder zusätzliche Abnahmebedingung erfinden. Der abschließende Skill-Check ist eine feste Prozesspflicht für regulär abgeschlossene geplante Aufträge, kein Auftrag zu unbegrenzter Skill-Optimierung: unveränderte Outcomes rechtfertigen keine wiederholten Checks oder identischen Ergänzungen. Ein expliziter Operatorabschluss beendet automatische Arbeit auch dann, wenn dieser Check oder eine Skill-Änderung technisch noch offen ist; der Restbefund wird nur dokumentiert.

### Sichtbarkeit im Main-Thread

Die Todo-Liste muss in der normalen Ausgabe des Main-Threads für den Operator sichtbar sein; ein internes Ledger, separater Dashboard-Tab oder nur ein `/status`-Befehl genügt nicht.

- Bei einem planpflichtigen Auftrag zeigt Main den initialen Plan einschließlich Recherchepunkten an.
- Bei einer fachlichen Fortschrittsmeldung zeigt Main den aktuellen Planstand mit erledigten, laufenden, wartenden und offenen Punkten. Neue oder entfallene Todos werden kenntlich gemacht und kurz aus dem Outcome beziehungsweise der Operator-Klarstellung begründet.
- Operatoränderungen und der Operatorabschluss erscheinen nachvollziehbar im selben Thread. Abschluss bedeutet sichtbar `Auftrag erledigt`, gegebenenfalls mit separat ausgewiesenen technischen Restbefunden; diese erzeugen keine automatische Fortsetzung.
- Die Ausgabe wird aus dem gespeicherten, versionierten Plan gerendert. Main erfindet keine zweite abweichende Liste; angezeigte Häkchen benötigen die gespeicherten Outcomes.
- Kein Versand einer neuen Liste bei jedem Toolaufruf, Validatorlauf, Polling oder unverändertem Zustand. Statusänderungen werden an sinnvollen Turn-Ende-/Ergebnisgrenzen gebündelt; falls der Kanal Updates unterstützt, kann dieselbe Planansicht aktualisiert werden. Ein neues Operatorgespräch darf nicht durch nachträgliche Statusupdates alter Themen überlagert werden.
- Der Dispatcher-/Validator-Plan ist fachlicher Auftragsfortschritt, keine interne Verarbeitungstelemetrie. Modellwahl, interne Prompts, Retryrunden und technische Orchestrierung bleiben außerhalb dieser Darstellung.
- Triviale und einfache Aufgaben liefern weiterhin unmittelbar ihre Antwort ohne Todo-Liste.

Beispiel einer aus dem gespeicherten Plan abgeleiteten Main-Ausgabe:

```text
Auftrag: Ursache der wiederholten Validierungen beheben

[x] Memory und bisherige Entscheidungen abgleichen
[x] Relevante Skills recherchieren
[x] Live-Belege und relevante Codepfade untersuchen
[x] Offizielle Dokumentation recherchieren
[>] Korrektur und Regressionstests umsetzen
[ ] Vollständige Prüfung und reguläre Veröffentlichung
[ ] Skill-Check abschließen und erforderliche Skill-Änderungen ausführen
[ ] Aktivierung und beobachtetes Ergebnis bestätigen

Neu: Regression für verspätete Ergebnisse ergänzt,
weil der reproduzierte Fehler abgeschlossene Aufträge wieder öffnet.
```

## 4. Validierung gegen den Auftrag

Vor einer Modellprüfung prüft der Host ohne Modellaufruf:

1. Ist der Operatorauftrag offen und diese Generation noch gültig?
2. Gibt es einen offenen Todo-Punkt oder einen echten noch offenen begrenzten Auftrag?
3. Liegt ein neues relevantes Outcome oder eine neue Operator-Klarstellung vor?
4. Wurde diese Evidenzrevision bereits bewertet?

Nur dann wird die auftragsgebundene Evidenz geprüft. Vollständige Sessionhistorie, andere alte Aufgaben und flüchtige Dispatcher-Metadaten sind keine neue Arbeitsgrundlage. Ein fehlgeschlagenes technisches Prüfen erhält einen eigenen begrenzten Retry-Besitzer und darf keine neue Arbeit oder neue Todos autorisieren.

## 5. Host-Gates und Persistenz

Der Operatorstatus muss vor jeder Admission, jedem Worker-/Main-Turn und jeder wirkenden Tooloperation geprüft werden. Derselbe Status gilt für API, Matrix, Cron, native Hosts und Kubernetes. Dauerhafte Receipts und Versionsfences überstehen Restart und Sessionwechsel.

Auftrag schließen bedeutet: keine neuen automatischen produktiven Admissions; gespeicherte Resume-Permits verlieren ihre Ausführungsberechtigung. Ein laufender unbekannter Seiteneffekt wird nicht als ungeschehen behandelt. Worker werden kontrolliert an sicheren Grenzen beendet oder checkpointen ihren tatsächlichen Effektstatus. Verspätete Outcomes werden historisch zugeordnet, nicht als neue Autorität verarbeitet.

Implementierung auf dem bestehenden dauerhaften Ausführungs-/Taskbestand aufbauen, nicht nebenher einen konkurrierenden Scheduler oder ein zweites Authority-System einführen.

## 6. Migration und Abnahme

Historische `active`-Records sind kein Beweis fortbestehender Operatorintention. Sie dürfen nicht pauschal alle reaktiviert werden. Migration benötigt eine explizite operatorgeführte Disposition/Zuordnung der Altaufträge; bis dahin keine automatische Wiederbelebung ungeklärter Altmandate. Bereits gespeicherte technische Outcomes und unklare Effekte werden nicht gelöscht.

Pflichtregressionen:

- Operator erledigt, technisch offen: kein Validator, Retry oder Resume, auch nach Restart/Sessionwechsel.
- Klarstellung/Neueröffnung derselben Absicht: exakt eine neue Generation; alte Permits bleiben ungültig.
- Verspätetes Worker-Ergebnis öffnet erledigten Auftrag nicht.
- Inaktivitätsfrist wird nicht durch Agentenaktivität verlängert.
- Wiederkehrender Cron: klare Serien-/Ausführungsgrenzen und kein Altresultat als neuer Trigger.
- Validator fordert denselben Punkt erneut ohne Outcomeänderung: kein neuer Modell-/Worker-Turn.
- Fachlich abgeschlossene Todos bleiben bei technischen Metadatenänderungen abgeschlossen.
- Outcome-basiertes neues Todo nur innerhalb Originalrequest plus Klarstellungen; Operatorablehnung dominiert.
- Skill-Research und abschließender Skill-Check erscheinen im gespeicherten Plan und der Main-Ausgabe; ein belegtes Ergebnis `keine Änderung erforderlich` schließt den Check ab.
- Outcome-begründete Skill-Korrektur wird genau einmal als sichtbares Todo übernommen, ausgeführt, geprüft und über den vorgesehenen Weg ausgeliefert; keine doppelte Ergänzung bei Retry/Restart.
- Operatorabschluss verhindert auch bei offenem Skill-Check automatische Wiederaufnahme; ein Skill-Verbesserungsvorschlag verleiht keine neue Autorität.
- Trivia ohne Plan- und Validator-Overhead.
- Crash während Abschluss/Neueröffnung/Outcomeübernahme: kein doppelter Effekt oder wieder gültiger alter Permit.

Offene Policyentscheidung: konkrete Inaktivitätsfrist(en) und sichtbare Behandlung expliziter Daueraufträge. Keine frei erfundene Frist ist implementiert.
