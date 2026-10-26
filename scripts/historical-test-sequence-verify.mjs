import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isSnapshot } from "../providers/provider-adapter.js";
import { buildEvaluationSummary } from "../providers/evaluation-contract.js";

const DATES = ["2026-10-22", "2026-10-23"];
const NORMAL_ORDER = ["0700", "0800", "0820", "0900", "1530"];
const OUT_OF_ORDER = ["0900", "0700", "1530", "0800", "0820"];

function round(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }

function settleRows(sourceRows, currentRows, stage) {
  const currentBySymbol = new Map((currentRows || []).map((row) => [row.symbol, row]));
  return sourceRows.map((sourceRow) => {
    const current = currentBySymbol.get(sourceRow.symbol) || {};
    const baseline = { ...sourceRow, actual_open: null, actual_close: null, actual_return: null, session_return: null, actual_volume: null, error: null };
    const row = { ...baseline, ...current };
    if (stage === "0700" || stage === "0800" || stage === "0820") {
      row.actual_open = current.actual_open ?? null;
      row.actual_close = current.actual_close ?? null;
      row.session_return = current.session_return ?? null;
      row.actual_volume = current.actual_volume ?? null;
      row.actual_return = current.actual_return ?? null;
      row.error = current.error ?? null;
    }
    if (stage === "0900") {
      row.actual_open = sourceRow.actual_open;
      row.actual_return = typeof row.actual_open === "number" && typeof row.prior_close === "number" && row.prior_close > 0 ? round((row.actual_open / row.prior_close - 1) * 100) : null;
      row.error = typeof row.actual_return === "number" && typeof row.expected_return === "number" ? round(row.actual_return - row.expected_return) : null;
      row.actual_close = current.actual_close ?? null;
      row.session_return = current.session_return ?? null;
      row.actual_volume = current.actual_volume ?? null;
    }
    if (stage === "1530") {
      row.actual_close = sourceRow.actual_close;
      row.actual_volume = sourceRow.actual_volume;
      row.session_return = typeof row.actual_open === "number" && typeof row.actual_close === "number" && row.actual_open > 0 ? round((row.actual_close / row.actual_open - 1) * 100) : null;
      row.actual_return = typeof row.actual_open === "number" && typeof row.prior_close === "number" && row.prior_close > 0 ? round((row.actual_open / row.prior_close - 1) * 100) : null;
      row.error = typeof row.actual_return === "number" && typeof row.expected_return === "number" ? round(row.actual_return - row.expected_return) : null;
    }
    return row;
  });
}

function buildSnapshot(source, date, stage, sequence, rows) {
  return {
    ...source,
    mode: "historical_test",
    status: "ready",
    rows,
    evaluation: buildEvaluationSummary(rows, {
      testOnly: true,
      dataset: "historical_test",
      asOfDate: date,
      forecastStage: "0820",
      actualStage: ["0900", "1530"].includes(stage) ? "0900" : null,
      inputDates: source.baseline?.input_dates || [],
      note: "Sequence verification is test-only and isolated from operating snapshots.",
    }),
    pipeline: {
      ...source.pipeline,
      previousResult: { ...source.pipeline.previousResult, status: sequence.indexOf("0700") <= sequence.indexOf(stage) ? "ready" : "pending" },
      analysis: { ...source.pipeline.analysis, status: sequence.indexOf("0800") <= sequence.indexOf(stage) ? "ready" : "pending" },
      forecast: { ...source.pipeline.forecast, status: sequence.indexOf("0820") <= sequence.indexOf(stage) ? "ready" : "pending" },
      openSettlement: { ...source.pipeline.openSettlement, status: sequence.indexOf("0900") <= sequence.indexOf(stage) ? "ready" : "pending" },
      closeSettlement: { ...source.pipeline.closeSettlement, status: sequence.indexOf("1530") <= sequence.indexOf(stage) ? "ready" : "pending" },
    },
    meta: {
      ...source.meta,
      test_only: true,
      historical_test: true,
      sequence_verification: true,
      sequence,
      applied_stage: stage,
      latest_snapshot_untouched: true,
      source_stage_snapshot: `data/historical-test/${date}.json`,
      data_classification: "test_only",
      evaluation_dataset: "historical_test",
      evaluation_test_only: true,
    },
  };
}

async function loadSource(date) {
  const source = JSON.parse(await readFile(resolve("data", "historical-test", `${date}.json`), "utf8"));
  assert.equal(isSnapshot(source), true);
  assert.equal(source.meta?.test_only, true);
  assert.equal(source.meta?.historical_test, true);
  return source;
}

async function verifySequence(date, source, sequence, label) {
  const outputRoot = resolve("data", "runs", "historical-test-verification", date, label);
  let currentRows = [];
  const expected = source.rows.map((row) => [row.symbol, row.expected_open, row.expected_return]);
  const files = [];
  for (const stage of sequence) {
    currentRows = settleRows(source.rows, currentRows, stage);
    const snapshot = buildSnapshot(source, date, stage, sequence, currentRows);
    const path = resolve(outputRoot, `${stage}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    files.push(path);
    assert.equal(snapshot.rows.map((row) => [row.symbol, row.expected_open, row.expected_return]).every((value, index) => JSON.stringify(value) === JSON.stringify(expected[index])), true, `${date}/${label}/${stage}: expected fields changed`);
  }
  const final = JSON.parse(await readFile(files.at(-1), "utf8"));
  assert.equal(final.rows.every((row) => row.actual_open !== null && row.actual_close !== null && row.actual_return !== null && row.error !== null), true, `${date}/${label}: final settlement is incomplete`);
  assert.equal(final.rows.every((row) => row.actual_return === round((row.actual_open / row.prior_close - 1) * 100)), true, `${date}/${label}: actual_return formula mismatch`);
  assert.equal(final.rows.every((row) => row.session_return === (row.actual_open > 0 ? round((row.actual_close / row.actual_open - 1) * 100) : null)), true, `${date}/${label}: session_return formula mismatch`);
  assert.equal(final.rows.every((row) => row.error === round(row.actual_return - row.expected_return)), true, `${date}/${label}: error formula mismatch`);
  return { date, sequence, label, files, rows: final.rows.length, expected_preserved: true, actual_open_formula: true, error_formula: true };
}

export async function run() {
  const results = [];
  for (const date of DATES) {
    const source = await loadSource(date);
    results.push(await verifySequence(date, source, NORMAL_ORDER, "normal"));
    results.push(await verifySequence(date, source, OUT_OF_ORDER, "out-of-order"));
  }
  const report = { mode: "historical_test_sequence_verification", test_only: true, latest_snapshot_written: false, results };
  const reportPath = resolve("data", "runs", "historical-test-verification", "verification-report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, report: reportPath }));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
