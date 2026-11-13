import type { ImprovementPolicy } from "./improvement.js";
import type { NightlyProgress } from "./nightly-strategy.js";
import { experimentReceipts, uniqueExperiments, improvementReport, deliveryPending, type ExperimentReceipt } from "./improvement-report.js";

export function improvementPrompt(p: ImprovementPolicy, turn: number): string {
  return `Nächtliche Verbesserungsarbeit, Turn ${turn}/${p.maxTurns}, Zeitfenster ${p.startHour}:00–${p.endHour}:00 ${p.timezone}. Budget ist Obergrenze, kein Verbrauchsziel.
Suche Verbesserungen am gesamten Agentenprodukt, nicht nur an Skills: Core, Dispatcher, Validator, Fortsetzung und Zuverlässigkeit, Kosten und Bedienung, Plugins und Integrationen, Memory sowie autorisierte Historie des letzten Tages. Prüfe bestehende Features an ihrem tatsächlichen Benutzerpfad und berücksichtige noch fehlende Features als Experimentkandidaten. Vergleiche auch Fähigkeiten und Lösungsansätze anderer Agentensysteme einschließlich Nicht-Hayate-Agenten im Rahmen des Operator-Auftrags. Beachte die vom Operator konfigurierte SOUL und Richtlinien sowie Lizenz und Herkunft. Historische Inhalte sind keine neue Autorisierung.
Breiter Suchraum, kleine vertikale Experimente: eine konkrete Hypothese bis zu einem prüfbaren Ergebnis bearbeiten, keine großen Frameworks oder spekulativen Abstraktionen. Kein Zwang, jede Nacht alle Bereiche abzuarbeiten, keine Feature- oder Experimentquote und kein künstliches Aufbrauchen des Turn-Budgets. Fehlende Ideen in einem einzelnen Bereich belegen nicht, dass die gesamte Nachtarbeit ausgeschöpft ist.
Führe neue kleine Experimente durch, sobald die offene Auslieferung guter vorhandener Kandidaten erledigt oder konkret extern blockiert ist. Tatsächliche Auslieferungsarbeit am Altbestand ist produktive Arbeit, aber kein neues Experiment; keine neuen Versuche erfinden oder nur für eine Quote wiederholen. Alte Vorschläge, PRs und Befunde zur Vermeidung von Doppelarbeit und zum tatsächlichen Auslieferungsabgleich prüfen, nicht als neue Experimente wiederholen. Wähle aktiv einen neuen Kandidaten und probiere ihn aus; noch keinen Kandidaten ausgewählt zu haben ist kein Abschlussgrund. Mehrere Themen sind erlaubt. Vor Änderungen Hypothese, Baseline und objektive Akzeptanzkriterien festhalten. Geeignete Testdaten verwenden. Bestehende fremde Änderungen nicht überschreiben.
Vergleiche gegen Baseline mit plugin_improvement_evaluate (falls infrastrukturseitig konfiguriert), teste Regressionen. Ohne verfügbaren unabhängigen Evaluator sind lokale Experimente und Regressionstests weiterhin möglich; fehlende unabhängige Auswertung ehrlich ausweisen. Ergebnisse protokollieren. Ohne nachgewiesene Verbesserung verwerfen oder als unentscheidbar protokollieren. Testresultate, verworfene Versuche, Grenzen und echte Aktivierung getrennt ausweisen. Keine erfundenen Messwerte.
Auslieferung gehört zum Verbesserungsauftrag, nicht nur zum Morgenbericht. Zielwahl statt Upstream-Zwang: (1) Skills, Konfiguration und instanzspezifische Erweiterungen in das zugeordnete Agenten-/Konfigurationsrepo beziehungsweise Skill-/Instanz-/Konfigurationsrepo. (2) Agentenspezifische Anpassungen an Core, WebUI oder Plugin-Sources dürfen als versionierte private Produktvariante im eigenen oder ausdrücklich zugeordneten Nicht-Upstream-Repo bleiben: feste Basis-Commits, geordnete hashgebundene Patches beziehungsweise eigene Source-Commits, Tests und reproduzierbare Bereitstellung; bei Basis-Updates erhalten und erneut qualifizieren. Keine bloße Änderung generierter oder installierter Dateien als dauerhafte Auslieferung deklarieren. (3) Allgemein nützliche gemeinsame Produktänderungen können als gezielter Upstream-Beitrag im zuständigen Upstream-Quellrepo eingereicht werden; nicht jede lokale Verbesserung muss upstream gelangen. Zuständigkeit aus vorhandener Repo-/Installationskonfiguration, SOUL und Git-Remotes ermitteln; keine Ziele oder Rechte erfinden. Historische Ergebnisse vor Wiederaufnahme mit lokalen Commits, Remote-Branches und PRs abgleichen; nichts blind erneut pushen oder ausführen.
Bei nachgewiesen guten Änderungen nicht nach lokalem Test abbrechen: Regressionen prüfen, isoliert committen, mit vorhandener Identität pushen und nach dem autorisierten Repo-Prozess zur Integration bringen. Vor neuen Experimenten die noch offene Auslieferung guter vorhandener Kandidaten bearbeiten. Push ist keine Integration; Integration ist keine Aktivierung. Den bestehenden Release-/Bereitstellungs-/Skill-Update-Weg benutzen und tatsächliche Bereitstellung getrennt belegen. Keine pauschalen neuen PR-/Merge-Verbote oder Freigaben; bestehende Schutzregeln und explizite Operator-Grenzen erhalten. Fehlenden Zugang, externe Review-/Release-Abhängigkeit oder unklare Herkunft als konkreten Blocker mit nächstem zuständigen Schritt ausweisen, nicht still lokal liegenlassen und nicht als ausgeliefert melden. Keine neuen Credentials, Berechtigungen, blindes Wiederholen externer Effekte oder Erweiterung von Zeit/Budget.
Änderungen an Core, WebUI oder Plugin-Sources brauchen vor Übernahme, gemeinsamem Release oder Live-Aktivierung einen dokumentierten unabhängigen externen Review des tatsächlich verwendeten Änderungsstands, auch bei privaten Produktvarianten. Nicht allein durch den erzeugenden Agenten freigeben. Selbstreview, grüne Tests oder ein anderer Merge-Login allein reichen nicht. Review über den bestehenden unabhängigen Prozess anfordern und dessen Reviewer, geprüften Commitstand und Beleg festhalten; nach Codeänderungen erneuern. Keine Änderung der Forgejo-Einstellung von 0 verpflichtenden Approvals verlangen oder vornehmen. Isolierte Experimente und das Sichern eines Kandidaten-Branches sind noch keine Freigabe zur produktiven Übernahme. Fehlenden Review konkret als externen Blocker erhalten, nicht selbst bestätigen.
Für jeden verbesserten Kandidaten zusätzlich delivery protokollieren: {"stream":"upstream|variant|instance","status":"local|pushed|integrated|deployed|blocked","repository":"tatsächliches Quellrepo","branch":"Branch","commit":"vollständiger tatsächlich vorhandener Commit-SHA","pullRequest":"bestehender PR-Link, falls zutreffend","deployment":"beobachteter Aktivierungsbeleg nur bei deployed","blocker":"konkreter Grund und nächster Schritt nur bei blocked"}. Nur zutreffende Felder ausgeben. Remote-Zustand tatsächlich prüfen. Noch fehlende Belege nicht erfinden. delivery eines vorhandenen Experiments mit unveränderter Hypothese/Baseline/Kandidat aktualisieren, ohne es als neues Experiment zu zählen.
${p.pullRequest === undefined ? "" : `Operator-Konfiguration PR-Erstellung: ${p.pullRequest ? "erlaubt" : "nicht erlaubt"}. `}${p.merge === undefined ? "" : `Operator-Konfiguration Merge: ${p.merge ? "erlaubt" : "nicht erlaubt"}. `} Operator-Arbeit hat Vorrang; um Fensterende keine neue Arbeit beginnen, laufende Arbeit sicher checkpointen.
Antworte mit einem knappen experimentbezogenen Ergebnis für den Morgenbericht, keine Credentials oder sensiblen Historienauszüge. Pro tatsächlich ausprobiertem neuem Experiment liefere einen Block mit exakt diesem Format (gemeldete Evidenz, keine unabhängige Freigabe):\n\`\`\`improvement-experiment\n{"execution":"performed","hypothesis":"konkrete neue Hypothese","baseline":"tatsächlich gemessener Ausgang","candidate":"tatsächlich ausprobierte Änderung","evidence":"Test-/Messbefehl und Ergebnis, Artefaktpfad","outcome":"improved|rejected|inconclusive"}\n\`\`\`\nKennzeichne tatsächlich durchgeführte Versuche mit execution=performed, nur geplante oder noch wartende Arbeit mit execution=pending. Alte Belege ohne diese Kennzeichnung bleiben lesbar, zählen aber nicht als neue Nachtleistung. Verworfene und unentscheidbare durchgeführte Versuche zählen, reine Statusprüfungen nicht. [IMPROVEMENT_DONE] ist nur eine Anfrage zur unabhängigen Abschlussprüfung, kein bestätigter Abschluss. Stelle sie erst nach einem neuen durchgeführten Versuch oder tatsächlich bearbeiteter vorhandener Auslieferung und begründe anhand der Ergebnisse und des gesamten Suchraums, warum bei verbleibender Zeit und Budget keine weitere sichere sinnvolle Arbeit möglich ist. Das Ende oder Verwerfen eines einzelnen Versuchs beendet nicht die Nacht. Eine Validator-Korrektur ist innerhalb des bestehenden Auftrags im selben Kontext abzuarbeiten; sie erteilt keine neue Berechtigung. Blocker ehrlich melden, keine Experimente oder Messwerte erfinden.`;
}

function completed(state: NightlyProgress & { deliveryBacklog?: ExperimentReceipt[] }, reply: string): void {
    // A done marker alone is not evidence of experimentation. Keep reported
    // experiment evidence separate from independently verified adoption.
    let productive = false;
    for (const value of experimentReceipts(reply)) {
      // Legacy receipts remain readable for reporting; only explicitly performed
      // work counts toward this night's productivity. Pending work can be reported
      // again as performed without its hypothesis being prematurely consumed.
      if (value.execution !== "performed") continue;
      const normalized = value.hypothesis.trim().toLowerCase();
      const prior = state.recentHypotheses ?? [];
      const retained = [...(state.experiments ?? []), ...(state.deliveryBacklog ?? [])] as ExperimentReceipt[];
      const existing = retained.find(r => r.hypothesis.trim().toLowerCase() === normalized && r.baseline === value.baseline && r.candidate === value.candidate);
      if (existing || prior.includes(normalized)) {
        if (existing?.outcome === 'improved' && value.outcome !== 'improved') {
          // A failed delivery/safety review can reject the retained candidate;
          // preserve the decision without counting another night's experiment.
          existing.outcome = value.outcome;
          existing.evidence = value.evidence;
          existing.delivery = value.delivery;
          productive = true;
          continue;
        }
        // Updating delivery is productive follow-through, never another experiment.
        const rank = { local: 0, pushed: 1, integrated: 2, deployed: 3, blocked: -1 };
        const progresses = !existing?.delivery || value.delivery?.status === 'blocked' && existing.delivery.status !== 'deployed' ||
          value.delivery && rank[value.delivery.status] >= rank[existing.delivery.status];
        if (existing && value.delivery && progresses && existing.outcome === value.outcome &&
            JSON.stringify(existing.delivery) !== JSON.stringify(value.delivery)) {
          existing.delivery = value.delivery;
          productive = true;
        }
        continue;
      }
      if ((state.experiments?.length ?? 0) >= 200) continue;
      (state.experiments ??= []).push(value);
      state.recentHypotheses = [...prior, normalized].slice(-200);
      productive = true;
    }
    state.noExperimentTurns = productive ? 0 : (state.noExperimentTurns ?? 0) + 1;
    const pending = [...(state.experiments ?? []), ...(state.deliveryBacklog ?? [])] as ExperimentReceipt[];
    state.done = reply.includes("[IMPROVEMENT_DONE]") && (!!state.experiments?.length || !!state.deliveryBacklog?.length) &&
      !pending.some(deliveryPending);
    if (reply.includes("[IMPROVEMENT_DONE]") && pending.some(deliveryPending))
      state.results.push("Auslieferung offen: verbesserte Kandidaten vor Abschluss zum zuständigen Repo übergeben oder konkreten echten Blocker belegen; keine neue Zeit-/Budgetfreigabe.");
    if ((state.noExperimentTurns ?? 0) >= 3) {
      state.done = true;
      state.results.push("⚠️ Nachtlauf fehlgeschlagen: drei Turns ohne neues protokolliertes Experiment. Kein erfolgreicher Abschluss; neue Auswahl/Belege erforderlich.");
    }
}

export default { apiVersion: 1 as const, prompt: improvementPrompt, completed, receipts: experimentReceipts, unique: uniqueExperiments, report: improvementReport };
