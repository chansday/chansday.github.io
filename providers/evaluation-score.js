// 종목 평가 (evaluation score): the mid-rank percentile (0–100) of a symbol's
// unrounded expected return among every symbol in the same snapshot that has
// one. Shared by the data pipeline (stored row fields) and the browser (render
// and fallback for snapshots written before these fields existed).
//
//   raw   = (expected_close / expected_open - 1) × 100, unrounded
//   N     = number of rows in the snapshot with a finite raw value
//   L     = rows whose raw value is strictly lower
//   E     = rows whose raw value is exactly equal (including the row itself)
//   score = (L + 0.5 × (E - 1)) / (N - 1) × 100        (N ≥ 2)
//   score = 50                                          (N = 1)
//
// This equals (average ascending rank - 1) / (N - 1) × 100: the highest unique
// value scores 100, the lowest unique value 0, and tied values share the mean
// of the ranks they occupy (all values equal → 50, consistent with N = 1).
// Rows without a raw value get no score (null) and are excluded from N.
// The score is rounded half up to 3 decimals with exact integer arithmetic:
//   thousandths = round_half_up((2L + E - 1) × 100000 / (2 × (N - 1)))
// (no floating-point rounding, which drifts for scores ≥ 10). Both the stored
// value and the display string come from that integer. Rank is the descending
// competition rank (1 + rows strictly higher), shared by ties.
import { rankingExpectedReturn } from "./evaluation-contract.js";

export const EVALUATION_SCORE_FIELDS = Object.freeze(["expected_return_raw", "evaluation_score", "evaluation_score_rank", "evaluation_score_count"]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Score in thousandths (integer 0..100000) for L lower and E equal rows of N.
// All operands are integers far below 2^53, so the division is exact.
export function scoreThousandths(lower, ties, count) {
  if (count === 1) return 50000;
  const numerator = (2 * lower + ties - 1) * 100000;
  const denominator = 2 * (count - 1);
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  return 2 * remainder >= denominator ? quotient + 1 : quotient;
}

function thousandthsText(value) {
  return `${Math.floor(value / 1000)}.${String(value % 1000).padStart(3, "0")}`;
}

// values: array of numbers or null. Returns one entry per input, null where the
// input has no finite value; otherwise { score, thousandths, rank, ties, count }
// where score = thousandths / 1000 (already rounded half up to 3 decimals).
export function computeEvaluationScores(values) {
  const list = Array.isArray(values) ? values : [];
  const present = list.filter(finite).sort((a, b) => a - b);
  const count = present.length;
  const lowerBound = (target) => { let lo = 0, hi = count; while (lo < hi) { const mid = (lo + hi) >> 1; if (present[mid] < target) lo = mid + 1; else hi = mid; } return lo; };
  const upperBound = (target) => { let lo = 0, hi = count; while (lo < hi) { const mid = (lo + hi) >> 1; if (present[mid] <= target) lo = mid + 1; else hi = mid; } return lo; };
  return list.map((value) => {
    if (!finite(value)) return null;
    const lower = lowerBound(value);
    const ties = upperBound(value) - lower;
    const thousandths = scoreThousandths(lower, ties, count);
    return { score: thousandths / 1000, thousandths, rank: count - lower - ties + 1, ties, count };
  });
}

// Pipeline helper: returns new rows with the four optional score fields set
// from the rows' own expected_open/expected_close. expected_return is untouched.
export function withEvaluationScores(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const raws = list.map((row) => rankingExpectedReturn(row));
  const scores = computeEvaluationScores(raws);
  return list.map((row, index) => ({
    ...row,
    expected_return_raw: raws[index],
    evaluation_score: scores[index]?.score ?? null,
    evaluation_score_rank: scores[index]?.rank ?? null,
    evaluation_score_count: scores[index]?.count ?? null,
  }));
}

// Display string for a score on the 0.001 grid (as produced above); the digits
// come from the integer thousandths, never from toFixed. 0..100 only.
export function formatEvaluationScore(score) {
  if (!finite(score) || score < 0 || score > 100) return "—";
  return thousandthsText(Math.round(score * 1000));
}

// The original (unrounded) expected return for tooltips, 4 decimals.
export function formatRawExpectedReturn(value) {
  if (!finite(value)) return "—";
  const rounded = Math.round((Math.abs(value) + Number.EPSILON) * 10000) / 10000;
  if (rounded === 0) return "0.0000%";
  return `${value > 0 ? "+" : "-"}${rounded.toFixed(4)}%`;
}

// Short visible text for touch layouts (no hover): "113위/885 · +0.0371%".
export function evaluationScoreSummary(entry, raw) {
  if (!entry || !finite(raw)) return "";
  return `${entry.ties > 1 ? "공동 " : ""}${entry.rank}위/${entry.count.toLocaleString("en-US")} · ${formatRawExpectedReturn(raw)}`;
}

export function evaluationScoreTooltip(entry, raw) {
  if (!entry || !finite(raw)) return "예상 시가·예상 종가가 없어 종목 평가를 계산하지 않았습니다";
  return `${entry.count.toLocaleString("en-US")}종목 중 ${entry.ties > 1 ? "공동 " : ""}${entry.rank}위 · 원래 값 ${formatRawExpectedReturn(raw)}`;
}
