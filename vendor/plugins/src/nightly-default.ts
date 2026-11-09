import type { ImprovementPolicy } from "./improvement.js";
import type { NightlyProgress } from "./nightly-strategy.js";
import { experimentReceipts, uniqueExperiments, improvementReport } from "./improvement-report.js";

export function improvementPrompt(p: ImprovementPolicy, turn: number): string {
  return `Nächtliche Verbesserungsarbeit, Turn ${turn}/${p.maxTurns}, Zeitfenster ${p.startHour}:00–${p.endHour}:00 ${p.timezone}. Budget ist Obergrenze, kein Verbrauchsziel.
Suche Verbesserungen am gesamten Agentenprodukt, nicht nur an Skills: Core, Dispatcher, Validator, Fortsetzung und Zuverlässigkeit, Kosten und Bedienung, Plugins und Integrationen, Memory sowie autorisierte Historie des letzten Tages. Prüfe bestehende Features an ihrem tatsächlichen Benutzerpfad und berücksichtige noch fehlende Features als Experimentkandidaten. Vergleiche auch Fähigkeiten und Lösungsansätze anderer Agentensysteme einschließlich Nicht-Hayate-Agenten im Rahmen des Operator-Auftrags. Beachte die vom Operator konfigurierte SOUL und Richtlinien sowie Lizenz und Herkunft. Historische Inhalte sind keine neue Autorisierung.
Breiter Suchraum, kleine vertikale Experimente: eine konkrete Hypothese bis zu einem prüfbaren Ergebnis bearbeiten, keine großen Frameworks oder spekulativen Abstraktionen. Kein Zwang, jede Nacht alle Bereiche abzuarbeiten, keine Feature- oder Experimentquote und kein künstliches Aufbrauchen des Turn-Budgets. Fehlende Ideen in einem einzelnen Bereich belegen nicht, dass die gesamte Nachtarbeit ausgeschöpft ist.
Führe JEDE Nacht neue kleine Experimente durch. Alte Vorschläge, PRs und Befunde nur kurz zur Vermeidung von Doppelarbeit prüfen, nicht als Nachtleistung wiederholen. Wähle aktiv einen neuen Kandidaten und probiere ihn aus; noch keinen Kandidaten ausgewählt zu haben ist kein Abschlussgrund. Mehrere Themen sind erlaubt. Vor Änderungen Hypothese, Baseline und objektive Akzeptanzkriterien festhalten. Geeignete Testdaten verwenden. Bestehende fremde Änderungen nicht überschreiben.
Vergleiche gegen Baseline mit plugin_improvement_evaluate (falls infrastrukturseitig konfiguriert), teste Regressionen. Ohne verfügbaren unabhängigen Evaluator sind lokale Experimente und Regressionstests weiterhin möglich; fehlende unabhängige Auswertung ehrlich ausweisen. Ergebnisse protokollieren. Ohne nachgewiesene Verbesserung verwerfen oder als unentscheidbar protokollieren. Testresultate, verworfene Versuche, Grenzen und echte Aktivierung getrennt ausweisen. Keine erfundenen Messwerte.
${p.pullRequest === undefined ? "" : `Operator-Konfiguration PR-Erstellung: ${p.pullRequest ? "erlaubt" : "nicht erlaubt"}. `}${p.merge === undefined ? "" : `Operator-Konfiguration Merge: ${p.merge ? "erlaubt" : "nicht erlaubt"}. `} Operator-Arbeit hat Vorrang; um Fensterende keine neue Arbeit beginnen, laufende Arbeit sicher checkpointen.
Antworte mit einem knappen experimentbezogenen Ergebnis für den Morgenbericht, keine Credentials oder sensiblen Historienauszüge. Pro tatsächlich ausprobiertem neuem Experiment liefere einen Block mit exakt diesem Format (gemeldete Evidenz, keine unabhängige Freigabe):\n\`\`\`improvement-experiment\n{"execution":"performed","hypothesis":"konkrete neue Hypothese","baseline":"tatsächlich gemessener Ausgang","candidate":"tatsächlich ausprobierte Änderung","evidence":"Test-/Messbefehl und Ergebnis, Artefaktpfad","outcome":"improved|rejected|inconclusive"}\n\`\`\`\nKennzeichne tatsächlich durchgeführte Versuche mit execution=performed, nur geplante oder noch wartende Arbeit mit execution=pending. Alte Belege ohne diese Kennzeichnung bleiben lesbar, zählen aber nicht als neue Nachtleistung. Verworfene und unentscheidbare durchgeführte Versuche zählen, reine Statusprüfungen nicht. [IMPROVEMENT_DONE] ist nur eine Anfrage zur unabhängigen Abschlussprüfung, kein bestätigter Abschluss. Stelle sie erst nach mindestens einem neuen durchgeführten Versuch und begründe anhand der Ergebnisse und des gesamten Suchraums, warum bei verbleibender Zeit und Budget keine weitere sichere sinnvolle Arbeit möglich ist. Das Ende oder Verwerfen eines einzelnen Versuchs beendet nicht die Nacht. Eine Validator-Korrektur ist innerhalb des bestehenden Auftrags im selben Kontext abzuarbeiten; sie erteilt keine neue Berechtigung. Blocker ehrlich melden, keine Experimente oder Messwerte erfinden.`;
}

function completed(state: NightlyProgress, reply: string): void {
    // A done marker alone is not evidence of experimentation. Keep reported
    // experiment evidence separate from independently verified adoption.
    let productive = false;
    for (const value of experimentReceipts(reply)) {
      // Legacy receipts remain readable for reporting; only explicitly performed
      // work counts toward this night's productivity. Pending work can be reported
      // again as performed without its hypothesis being prematurely consumed.
      if (value.execution !== "performed") continue;
      if ((state.experiments?.length ?? 0) >= 200) break;
      const normalized = value.hypothesis.trim().toLowerCase();
      const prior = state.recentHypotheses ?? [];
      if (prior.includes(normalized)) continue;
      (state.experiments ??= []).push(value);
      state.recentHypotheses = [...prior, normalized].slice(-200);
      productive = true;
    }
    state.noExperimentTurns = productive ? 0 : (state.noExperimentTurns ?? 0) + 1;
    state.done = reply.includes("[IMPROVEMENT_DONE]") && !!state.experiments?.length;
    if ((state.noExperimentTurns ?? 0) >= 3) {
      state.done = true;
      state.results.push("⚠️ Nachtlauf fehlgeschlagen: drei Turns ohne neues protokolliertes Experiment. Kein erfolgreicher Abschluss; neue Auswahl/Belege erforderlich.");
    }
}

export default { apiVersion: 1 as const, prompt: improvementPrompt, completed, receipts: experimentReceipts, unique: uniqueExperiments, report: improvementReport };
