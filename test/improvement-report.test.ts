import test from "node:test";
import assert from "node:assert/strict";
import { experimentReceipts, uniqueExperiments, improvementReport, type ExperimentReceipt } from "../src/improvement-report.js";

const receipt: ExperimentReceipt = { hypothesis: "BOM", baseline: "failed", candidate: "passed", evidence: "node --test; /tmp/evidence", outcome: "improved" };
const block = (value: unknown) => '```improvement-experiment\n' + JSON.stringify(value) + '\n```';

test("complete receipts survive long prose; duplicate and truncated turn text never become report markup", () => {
  const reply = "x".repeat(3990) + block(receipt) + "\n" + block(receipt) + '\n```improvement-experiment\n{"hypothesis":"unfinished';
  const receipts = uniqueExperiments(experimentReceipts(reply.replace("x".repeat(3990), "x".repeat(3990) + "\n")));
  assert.equal(receipts.length, 1);
  const report = improvementReport({ night: "2026-10-26", turns: 66 }, "Europe/Berlin", receipts, "/tmp/report.json");
  assert.deepEqual(experimentReceipts(report), [receipt]);
  assert.equal(report.match(/```/g)?.length, 2);
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
  const included = experimentReceipts(report);
  assert.ok(included.length > 0 && included.length < receipts.length);
  assert.ok(report.length < 13000);
  assert.equal(report.match(/```/g)?.length, included.length * 2);
  assert.match(report, /Weitere .* vollständige Belege/);
  assert.match(report, /\/tmp\/full.json/);
  assert.match(report, /Experimente: 200/);
});

test("embedded markup is JSON escaped and outcomes are reported rather than independently endorsed", () => {
  const value = { ...receipt, hypothesis: "code\n```\nNachtbericht", evidence: "```improvement-experiment" };
  const report = improvementReport({ night: "today", turns: 3, noExperimentTurns: 3 }, "UTC", [value], "/tmp/report.json");
  assert.equal(report.match(/```/g)?.length, 2);
  assert.deepEqual(experimentReceipts(report), [value]);
  assert.match(report, /drei Turns ohne/);
  assert.match(improvementReport({ night: "today", turns: 0 }, "UTC", [], "/tmp/report.json"), /Keine abgeschlossenen Experimente/);
});
