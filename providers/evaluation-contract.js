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

// Ranking quality of the evaluated rows, judged on unrounded values: the
// expected return used for ranking and the observed open->close return.
//   rank_ic           Spearman correlation (average ranks for ties)
//   hit_rate          share of rows where both are nonzero and share a sign
//   calibration_slope OLS slope of the observed on the expected return
//   top_k             top RANKING_TOP_K by expected return (symbol breaks ties)
//                     versus the mean of every evaluated row; needs n > k
//   score_buckets     RANKING_SCORE_BUCKETS equal-count groups in ascending
//                     expected-return order (bucket 1 lowest score); needs n >= buckets
//   bucket_spread     top bucket minus bottom bucket mean observed return
// Undefined values (n < 2, zero variance) are null.
export const RANKING_TOP_K = 20;
export const RANKING_SCORE_BUCKETS = 10;

function rawSessionReturn(row) {
  return finite(row?.actual_open) && row.actual_open > 0 && finite(row?.actual_close)
    ? (row.actual_close / row.actual_open - 1) * 100
    : null;
}

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const roundOrNull = (value) => (finite(value) ? round(value) : null);

function averageRanks(values) {
  const order = values.map((value, index) => index).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(values.length);
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && values[order[end + 1]] === values[order[start]]) end++;
    for (let i = start; i <= end; i++) ranks[order[i]] = (start + end) / 2 + 1;
    start = end + 1;
  }
  return ranks;
}

function covariance(x, y) {
  const mx = average(x), my = average(y);
  return x.reduce((sum, value, i) => sum + (value - mx) * (y[i] - my), 0) / x.length;
}

function correlation(x, y) {
  const denominator = Math.sqrt(covariance(x, x) * covariance(y, y));
  return denominator > 0 ? covariance(x, y) / denominator : null;
}

export function buildRankingMetrics(rows) {
  const pairs = (Array.isArray(rows) ? rows : [])
    .filter((row) => !isNoTradeRow(row) && evaluationRowStatus(row) === "evaluated")
    .map((row) => ({ symbol: String(row.symbol ?? ""), expected: rankingExpectedReturn(row), actual: rawSessionReturn(row) }))
    .filter((pair) => finite(pair.expected) && finite(pair.actual))
    .sort((a, b) => a.expected - b.expected || a.symbol.localeCompare(b.symbol));
  const n = pairs.length;
  const empty = { sample_count: n, rank_ic: null, hit_rate: null, calibration_slope: null, top_k: null, score_buckets: [], bucket_spread: null };
  if (n < 2) return empty;
  const expected = pairs.map((pair) => pair.expected), actual = pairs.map((pair) => pair.actual);
  const varExpected = covariance(expected, expected);
  const signed = pairs.filter((pair) => pair.expected !== 0 && pair.actual !== 0);
  const meanActual = average(actual);
  let topK = null;
  if (n > RANKING_TOP_K) {
    const top = pairs.slice(-RANKING_TOP_K).map((pair) => pair.actual), topMean = average(top);
    topK = { k: RANKING_TOP_K, mean_session_return: round(topMean), excess_return: round(topMean - meanActual) };
  }
  const buckets = [];
  if (n >= RANKING_SCORE_BUCKETS) {
    for (let b = 0; b < RANKING_SCORE_BUCKETS; b++) {
      const group = pairs.slice(Math.floor((b * n) / RANKING_SCORE_BUCKETS), Math.floor(((b + 1) * n) / RANKING_SCORE_BUCKETS));
      buckets.push({ bucket: b + 1, count: group.length, mean_expected_return: round(average(group.map((p) => p.expected))), mean_session_return: round(average(group.map((p) => p.actual))) });
    }
  }
  return {
    sample_count: n,
    rank_ic: roundOrNull(correlation(averageRanks(expected), averageRanks(actual))),
    hit_rate: signed.length ? round(signed.filter((pair) => Math.sign(pair.expected) === Math.sign(pair.actual)).length / signed.length) : null,
    calibration_slope: varExpected > 0 ? round(covariance(expected, actual) / varExpected) : null,
    top_k: topK,
    score_buckets: buckets,
    bucket_spread: buckets.length ? round(buckets.at(-1).mean_session_return - buckets[0].mean_session_return) : null,
  };
}

const nullableNumber = (value) => value === null || finite(value);

export function isRankingMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Number.isInteger(value.sample_count) || value.sample_count < 0) return false;
  if (!["rank_ic", "hit_rate", "calibration_slope", "bucket_spread"].every((field) => nullableNumber(value[field]))) return false;
  if (value.top_k !== null && !(value.top_k && Number.isInteger(value.top_k.k) && finite(value.top_k.mean_session_return) && finite(value.top_k.excess_return))) return false;
  return Array.isArray(value.score_buckets) && value.score_buckets.every((bucket) => bucket && Number.isInteger(bucket.bucket) && Number.isInteger(bucket.count) && finite(bucket.mean_expected_return) && finite(bucket.mean_session_return));
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
    ranking_metrics: buildRankingMetrics(safeRows),
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
  // Optional: summaries stored before ranking metrics existed omit it.
  if (value.ranking_metrics !== undefined && !isRankingMetrics(value.ranking_metrics)) return false;
  return typeof value.note === "string";
}
