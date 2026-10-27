import { buildEvaluationSummary, deriveExpectedReturn, deriveSessionReturn, deriveEvaluationError } from "./evaluation-contract.js";

// Keep observed fields from the operating snapshot; overlay only a matched run's
// retrospective estimates. Never mix forecasts from different runs or dates.
export function mergePostCloseEvaluation(snapshot, record) {
  const date = snapshot?.meta?.run_date, runId = snapshot?.meta?.run_id;
  if (snapshot?.status !== "ready" || snapshot?.meta?.run_stage !== "close-settlement" || record?.schema_version !== 1 || record.kind !== "post_close_retrospective" || record.run_date !== date || record.run_id !== runId || !Array.isArray(record.rows) || !Array.isArray(snapshot.rows) || record.rows.length !== snapshot.rows.length || !Array.isArray(record.history_dates) || record.history_dates.length !== 3 || record.history_dates.some((d) => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d >= date)) throw new Error("Invalid retrospective identity or history");
  const matches = new Map();
  for (const row of record.rows) {
    if (!row || typeof row.symbol !== "string" || matches.has(row.symbol)) throw new Error("Invalid retrospective row");
    matches.set(row.symbol, row);
  }
  const seen = new Set();
  const rows = snapshot.rows.map((source) => {
    const row = matches.get(source.symbol);
    if (!row || seen.has(source.symbol) || row.actual_open !== (source.actual_open > 0 ? source.actual_open : null) || row.actual_close !== (source.actual_close > 0 ? source.actual_close : null)) throw new Error("Retrospective observation mismatch");
    seen.add(source.symbol);
    if (![row.expected_open, row.expected_close].every((value) => value === null || (typeof value === "number" && Number.isFinite(value) && value > 0)) || (row.expected_open === null) !== (row.expected_close === null)) throw new Error("Invalid retrospective estimate");
    const merged = { ...source, expected_open: row.expected_open, expected_close: row.expected_close };
    return { ...merged, expected_return: deriveExpectedReturn(merged), session_return: deriveSessionReturn(merged), error: deriveEvaluationError(merged) };
  });
  const evaluation = buildEvaluationSummary(rows, { testOnly: true, dataset: "historical_test", asOfDate: date, forecastStage: "0820", actualStage: "1530", inputDates: [...record.history_dates].reverse(), note: record.notice });
  return { ...snapshot, rows, evaluation, meta: { ...snapshot.meta, retrospective_evaluation: true }, retrospective_history_dates: record.history_dates };
}
