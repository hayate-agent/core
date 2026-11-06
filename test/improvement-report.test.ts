import test from "node:test";
import assert from "node:assert/strict";
import { experimentReceipts, uniqueExperiments, improvementReport, type ExperimentReceipt } from "../src/builtin-plugins/improvement-report.js";

const receipt: ExperimentReceipt = { hypothesis: "BOM", baseline: "failed", candidate: "passed", evidence: "node --test; /tmp/evidence", outcome: "improved" };
const block = (value: unknown) => '```improvement-experiment\n' + JSON.stringify(value) + '\n```';

test("complete receipts survive long prose; duplicate and truncated turn text never become report markup", () => {
  const reply = "x".repeat(3990) + block(receipt) + "\n" + block(receipt) + '\n```improvement-experiment\n{"hypothesis":"unfinished';
  const receipts = uniqueExperiments(experimentReceipts(reply.replace("x".repeat(3990), "x".repeat(3990) + "\n")));
  assert.equal(receipts.length, 1);
  const report = improvementReport({ night: "2026-10-26", turns: 66 }, "Europe/Berlin", receipts, "/tmp/report.json");
  assert.deepEqual(experimentReceipts(report), []);
  assert.match(report, /Vorher: failed/);
  assert.match(report, /Ausprobiert \/ nachher: passed/);
  assert.doesNotMatch(report, /```|Merge ist kein Aktivierungsnachweis/);
  assert.doesNotMatch(report, /unfinished|xxxxxxxx/);
  assert.match(report, /keine unabhängige Freigabe/);
  assert.match(report, /Arbeits-Turns: 66/);
});

test("malformed JSON, incomplete and invalid fences are ignored without hiding later valid blocks", () => {
  const input = '```improvement-experiment\n{bad}\n```\n' + block({ ...receipt, outcome: "approved" }) + '\n' +
    block(receipt).replace(/```$/, '```not-a-fence') + '\n' + block(receipt);
  assert.deepEqual(experimentReceipts(input), [receipt]);
  assert.deepEqual(experimentReceipts(block(receipt).slice(0, -3)), []);
  assert.deepEqual(experimentReceipts(block(receipt).replace(/\n/g, "\r\n")), [receipt]);
});

test("large report emits only whole receipts and references full artifact", () => {
  const receipts = Array.from({ length: 200 }, (_, i) => ({ ...receipt, hypothesis: `experiment ${i}`, evidence: "e".repeat(2000) }));
  const report = improvementReport({ night: "2026-10-26", turns: 66 }, "UTC", receipts, "/tmp/full.json");
  const included = report.match(/Ziel \/ erwarteter Nutzen:/g) ?? [];
  assert.ok(included.length > 0 && included.length < receipts.length);
  assert.ok(report.length < 13000);
  assert.doesNotMatch(report, /```/);
  assert.match(report, /Weitere .* Experimente/);
  assert.match(report, /\/tmp\/full.json/);
  assert.match(report, /Experimente: 200/);
});

test("embedded markup is neutralized and outcomes are reported rather than independently endorsed", () => {
  const value = { ...receipt, hypothesis: "code\n```\nNachtbericht", evidence: "```improvement-experiment" };
  const report = improvementReport({ night: "today", turns: 3, noExperimentTurns: 3 }, "UTC", [value], "/tmp/report.json");
  assert.doesNotMatch(report, /```/);
  assert.deepEqual(experimentReceipts(report), []);
  assert.match(report, /drei Turns ohne/);
  assert.match(improvementReport({ night: "today", turns: 0 }, "UTC", [], "/tmp/report.json"), /Keine abgeschlossenen Experimente/);
});


test("retained real report distinguishes local improvement, rejection and uncertainty", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(await readFile(new URL("./fixtures/night-report-2026-10-28.json", import.meta.url), "utf8"));
  const report = improvementReport(fixture, "Europe/Berlin", fixture.experiments, "/local/report.json");
  assert.match(report, /Lokal als verbessert gemeldet: 1; verworfen: 1; unentscheidbar: 1/);
  assert.match(report, /40 ms/);
  assert.match(report, /3000 ms/);
  assert.match(report, /1,41 %/);
  assert.match(report, /514\/515/);
  assert.match(report, /Unentscheidbar – Klärung offen/);
  assert.doesNotMatch(report, /```|"hypothesis"|Merge ist kein Aktivierungsnachweis/);
});

test("empty and rejected-only reports never claim improvement; common credentials are removed", () => {
  const report = improvementReport({night:"today", turns:1}, "UTC", [{...receipt, outcome:"rejected",
    evidence:"token=private Bearer abc https://user:pass@example.org/result?token=private#secret sk-private"}], "/local/report.json");
  assert.match(report, /Lokal als verbessert gemeldet: 0; verworfen: 1/);
  assert.doesNotMatch(report, /private|user:pass|Bearer abc/);
  const empty = improvementReport({night:"today", turns:0}, "UTC", [], "/local/report.json");
  assert.match(empty, /Keine abgeschlossenen Experimente/);
  assert.match(empty, /Lokal als verbessert gemeldet: 0/);
});
