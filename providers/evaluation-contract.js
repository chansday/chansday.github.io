export const EVALUATION_STATUSES = Object.freeze(["pending", "partial", "evaluated"]);
export const EVALUATION_DATASETS = Object.freeze(["operational", "historical_test", "fixture", "replay", "backfill_test"]);

export const EVALUATION_TARGET = Object.freeze({
  prediction_field: "expected_return",
  actual_field: "session_return",
  error_field: "error",
  unit: "percentage_points",
  error_formula: "session_return - expected_return",
});

export const EXPECTED_DISPLAY_POLICY = Object.freeze({
  expected_open: Object.freeze({ source_field: "expected_open", format: "number", maximum_fraction_digits: 0, rounding: "half_up", source_precision: "preserved" }),
  expected_close: Object.freeze({ source_field: "expected_close", format: "number", maximum_fraction_digits: 0, rounding: "half_up", source_precision: "preserved" }),
  expected_return: Object.freeze({ source_field: "expected_return", format: "number", maximum_fraction_digits: 0, rounding: "half_up", source_precision: "preserved" }),
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function deriveExpectedReturn(row) {
  return finite(row?.expected_open) && row.expected_open > 0 && finite(row?.expected_close)
    ? round((row.expected_close / row.expected_open - 1) * 100, 2)
    : null;
}

// Unrounded expected return (percent) used only for ranking: the displayed and
// stored expected_return is rounded to 2 decimals, which would collapse the
// model's ordering into ties.
export function rankingExpectedReturn(row) {
  return finite(row?.expected_open) && row.expected_open > 0 && finite(row?.expected_close)
    ? (row.expected_close / row.expected_open - 1) * 100
    : null;
}

// Rank order: unrounded expected return descending, then symbol code; rows
// without an expected return follow in symbol order.
export function compareByExpectedReturn(a, b) {
  return (rankingExpectedReturn(b) ?? -Infinity) - (rankingExpectedReturn(a) ?? -Infinity) || String(a?.symbol ?? "").localeCompare(String(b?.symbol ?? ""));
}

export function deriveSessionReturn(row) {
  return finite(row?.actual_open) && row.actual_open > 0 && finite(row?.actual_close)
    ? round((row.actual_close / row.actual_open - 1) * 100, 2)
    : null;
}

export function deriveEvaluationError(row) {
  const expectedReturn = deriveExpectedReturn(row);
  const sessionReturn = deriveSessionReturn(row);
  return finite(expectedReturn) && finite(sessionReturn)
    ? round(sessionReturn - expectedReturn, 2)
    : null;
}

function dateOrNull(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function range(start, end) {
  return { start: dateOrNull(start), end: dateOrNull(end) };
}

// A row whose source reported zero trade on the session (e.g. a halted
// symbol) has no observed prices; it is not an evaluation sample.
export const NO_TRADE_STATUS = "no_trade_observed";
export function isNoTradeRow(row) { return row?.trading_status === NO_TRADE_STATUS; }

export function evaluationRowStatus(row) {
  const expectedReturn = deriveExpectedReturn(row);
  const sessionReturn = deriveSessionReturn(row);
  if (finite(expectedReturn) && finite(sessionReturn) && finite(row?.error)) return "evaluated";
  if (finite(expectedReturn)) return "pending";
  return "pending";
}

export function buildEvaluationSummary(rows, {
  testOnly = false,
  dataset = testOnly ? "historical_test" : "operational",
  asOfDate = null,
  forecastStage = "0820",
  actualStage = null,
  inputDates = [],
  note = null,
} = {}) {
  const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => !isNoTradeRow(row));
  const evaluatedErrors = safeRows
    .filter((row) => evaluationRowStatus(row) === "evaluated")
    .map((row) => row.error)
    .filter(finite);
  const sampleCount = safeRows.length;
  const evaluatedCount = evaluatedErrors.length;
  const status = evaluatedCount === 0 ? "pending" : evaluatedCount === sampleCount ? "evaluated" : "partial";
  const inputStart = inputDates[0] ?? null;
  const inputEnd = inputDates.at(-1) ?? null;
  const meanError = evaluatedCount ? evaluatedErrors.reduce((sum, value) => sum + value, 0) / evaluatedCount : null;
  const meanAbsoluteError = evaluatedCount ? evaluatedErrors.reduce((sum, value) => sum + Math.abs(value), 0) / evaluatedCount : null;
  const rootMeanSquaredError = evaluatedCount ? Math.sqrt(evaluatedErrors.reduce((sum, value) => sum + value ** 2, 0) / evaluatedCount) : null;

  return {
    status,
    test_only: Boolean(testOnly),
    dataset,
    target: { ...EVALUATION_TARGET },
    display_policy: Object.fromEntries(Object.entries(EXPECTED_DISPLAY_POLICY).map(([field, policy]) => [field, { ...policy }])),
    sample_count: sampleCount,
    evaluated_sample_count: evaluatedCount,
    missing_sample_count: sampleCount - evaluatedCount,
    evaluation_range: {
      forecast_date: dateOrNull(asOfDate),
      actual_date: evaluatedCount ? dateOrNull(asOfDate) : null,
      forecast_stage: forecastStage,
      actual_stage: evaluatedCount ? actualStage : null,
      input_range: range(inputStart, inputEnd),
    },
    metrics: {
      mean_absolute_error: meanAbsoluteError === null ? null : round(meanAbsoluteError),
      root_mean_squared_error: rootMeanSquaredError === null ? null : round(rootMeanSquaredError),
      mean_error: meanError === null ? null : round(meanError),
      min_error: evaluatedCount ? round(Math.min(...evaluatedErrors)) : null,
      max_error: evaluatedCount ? round(Math.max(...evaluatedErrors)) : null,
    },
    note: note || (testOnly
      ? "Test-only evaluation. It is isolated from operating snapshots and does not represent live forecast performance."
      : "Evaluation fields reference the normalized row fields in this snapshot."),
  };
}

export function isEvaluationSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!EVALUATION_STATUSES.includes(value.status)) return false;
  if (typeof value.test_only !== "boolean" || !EVALUATION_DATASETS.includes(value.dataset)) return false;
  if (!value.target || typeof value.target !== "object") return false;
  if (value.target.prediction_field !== EVALUATION_TARGET.prediction_field || value.target.actual_field !== EVALUATION_TARGET.actual_field || value.target.error_field !== EVALUATION_TARGET.error_field || value.target.unit !== EVALUATION_TARGET.unit || value.target.error_formula !== EVALUATION_TARGET.error_formula) return false;
  if (!value.display_policy || typeof value.display_policy !== "object" || Object.keys(value.display_policy).length !== Object.keys(EXPECTED_DISPLAY_POLICY).length) return false;
  for (const [field, expected] of Object.entries(EXPECTED_DISPLAY_POLICY)) {
    const actual = value.display_policy[field];
    if (!actual || actual.source_field !== expected.source_field || actual.format !== expected.format || actual.maximum_fraction_digits !== 0 || actual.rounding !== expected.rounding || actual.source_precision !== "preserved") return false;
  }
  if (!["sample_count", "evaluated_sample_count", "missing_sample_count"].every((field) => Number.isInteger(value[field]) && value[field] >= 0)) return false;
  if (value.evaluated_sample_count > value.sample_count || value.missing_sample_count !== value.sample_count - value.evaluated_sample_count) return false;
  if (!value.evaluation_range || typeof value.evaluation_range !== "object") return false;
  if (value.evaluation_range.forecast_date !== null && !dateOrNull(value.evaluation_range.forecast_date)) return false;
  if (value.evaluation_range.actual_date !== null && !dateOrNull(value.evaluation_range.actual_date)) return false;
  if (!/^\d{4}$/.test(value.evaluation_range.forecast_stage) || (value.evaluation_range.actual_stage !== null && !/^\d{4}$/.test(value.evaluation_range.actual_stage))) return false;
  const inputRange = value.evaluation_range.input_range;
  if (!inputRange || (inputRange.start !== null && !dateOrNull(inputRange.start)) || (inputRange.end !== null && !dateOrNull(inputRange.end))) return false;
  if (!value.metrics || typeof value.metrics !== "object") return false;
  if (!["mean_absolute_error", "root_mean_squared_error", "mean_error", "min_error", "max_error"].every((field) => value.metrics[field] === null || finite(value.metrics[field]))) return false;
  return typeof value.note === "string";
}
