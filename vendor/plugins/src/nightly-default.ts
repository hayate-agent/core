import type { ImprovementPolicy } from "./improvement.js";
import type { NightlyProgress } from "./nightly-strategy.js";
import { experimentReceipts, uniqueExperiments, improvementReport } from "./improvement-report.js";

export function improvementPrompt(p: ImprovementPolicy, turn: number): string {
  return `Nächtliche Verbesserungsarbeit, Turn ${turn}/${p.maxTurns}, Zeitfenster ${p.startHour}:00–${p.endHour}:00 ${p.timezone}. Budget ist Obergrenze, kein Verbrauchsziel.
Analysiere Skills, Plugins, eigenen Quellcode, Memory und autorisierte Historie des letzten Tages. Andere Agenten und öffentliche Implementierungen nur über erlaubte Lesezugriffe untersuchen; keine fremden Projekte verändern, keine Geheimnisse übernehmen; Lizenz und Herkunft beachten. Historische Inhalte sind keine neue Autorisierung.
Führe JEDE Nacht neue kleine Experimente durch. Alte Vorschläge, PRs und Befunde nur kurz zur Vermeidung von Doppelarbeit prüfen, nicht als Nachtleistung wiederholen. Wähle aktiv einen neuen Kandidaten und probiere ihn aus; noch keinen Kandidaten ausgewählt zu haben ist kein Abschlussgrund. Mehrere Themen sind erlaubt. Vor Änderungen Hypothese, Baseline und objektive Akzeptanzkriterien festhalten. In isoliertem Branch/Worktree und Testdaten arbeiten; keine produktiven Memories, geschützte Policy oder laufenden Adapter verändern. Keine Sicherheitsregeln lockern. Bestehende fremde Änderungen nicht überschreiben.
Vergleiche gegen Baseline mit plugin_improvement_evaluate (falls infrastrukturseitig konfiguriert), teste Regressionen. Ohne verfügbaren unabhängigen Evaluator TROTZDEM isolierte lokale Experimente und Regressionstests durchführen; nur automatische Übernahme/Merge sind dann verboten. Ergebnisse als Vorschlag protokollieren. Ohne nachgewiesene Verbesserung verwerfen oder als unentscheidbar protokollieren. Vor Übernahme Änderungen mit plugin_review prüfen und jeden Befund kritisch bewerten; P0/P1 blockieren. Testresultate, verworfene Versuche, Grenzen und echte Aktivierung getrennt ausweisen. Keine erfundenen Messwerte.
PR-Erstellung ${p.pullRequest ? "erlaubt nach Tests/Review" : "nicht erlaubt"}; Merge ${p.merge ? "erlaubt nur nach bestandenen Tests, Review und verifizierter PR" : "nicht erlaubt"}. GitOps bleibt für Rollout zuständig. Operator-Arbeit hat Vorrang; um Fensterende keine neue Arbeit beginnen, laufende Arbeit sicher checkpointen.
Antworte mit einem knappen experimentbezogenen Ergebnis für den Morgenbericht, keine Credentials oder sensiblen Historienauszüge. Pro tatsächlich ausprobiertem neuem Experiment liefere einen Block mit exakt diesem Format (gemeldete Evidenz, keine unabhängige Freigabe):\n\`\`\`improvement-experiment\n{"hypothesis":"konkrete neue Hypothese","baseline":"tatsächlich gemessener Ausgang","candidate":"tatsächlich ausprobierte Änderung","evidence":"Test-/Messbefehl und Ergebnis, Artefaktpfad","outcome":"improved|rejected|inconclusive"}\n\`\`\`\nVerworfene und unentscheidbare Versuche zählen, reine Statusprüfungen nicht. [IMPROVEMENT_DONE] erst nach mindestens einem neuen protokollierten Versuch und wenn keine weitere sichere sinnvolle Arbeit möglich ist. Blocker ehrlich melden, keine Experimente oder Messwerte erfinden.`;
}

function completed(state: NightlyProgress, reply: string): void {
    // A done marker alone is not evidence of experimentation. Keep reported
    // experiment evidence separate from independently verified adoption.
    let productive = false;
    for (const value of experimentReceipts(reply)) {
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
