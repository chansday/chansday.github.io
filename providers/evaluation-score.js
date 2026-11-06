// 종목 평가 (evaluation score): a sign-gated mid-rank percentile (0–100) of a
// symbol's unrounded expected return among every symbol in the same snapshot
// that has one. Shared by the data pipeline (stored row fields) and the
// browser (render and fallback for snapshots written before these fields
// existed).
//
//   raw = (expected_close / expected_open - 1) × 100, unrounded
//
// A negative expected return can never score above 50, and a positive
// expected return can never score below 50: the percentile is computed
// separately within the positive group and the negative group (so a stock
// is never ranked "high" purely for losing less than everything else on a
// red day), then each group's 0–100 local percentile is compressed into its
// own half of the 0–100 scale. A raw value of exactly 0 scores exactly 50,
// and so can the least-negative row of its group (worst positive, best
// negative, and exact zero all meet at the neutral midpoint, never above it
// for a loss).
//
//   group   = rows with raw > 0 ("pos"), raw < 0 ("neg"), or raw == 0
//   N       = size of the row's group (pos or neg only; irrelevant for raw == 0)
//   L       = rows in the same group whose raw value is strictly lower
//   E       = rows in the same group whose raw value is exactly equal (incl. itself)
//   local   = (L + 0.5 × (E - 1)) / (N - 1) × 100       (N ≥ 2)
//   local   = 50                                         (N = 1)
//   score   = 50 + local / 2   (raw > 0)  →  range [50, 100]
//   score   = local / 2        (raw < 0)  →  range [0, 50]
//   score   = 50                (raw == 0)
//
// Within a group this is the same mid-rank percentile as before (highest
// scores 100 locally, lowest 0, ties share the mean rank they occupy), just
// rescaled into its half. Rows without a raw value get no score (null).
// The score is rounded half up to 3 decimals with exact integer arithmetic
// (division by 2 of an integer is exact in IEEE 754, so no precision is lost
// rescaling the local thousandths). Rank and count stay global (computed
// across every scored row, not per group) since they describe the row's
// position among all evaluated symbols, independent of the score's sign gate.
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

function bounds(sorted) {
  const n = sorted.length;
  return {
    lower: (target) => { let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < target) lo = mid + 1; else hi = mid; } return lo; },
    upper: (target) => { let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= target) lo = mid + 1; else hi = mid; } return lo; },
  };
}

// values: array of numbers or null. Returns one entry per input, null where the
// input has no finite value; otherwise { score, thousandths, rank, ties, count }
// where score = thousandths / 1000 (already rounded half up to 3 decimals),
// rank/ties/count are global (see file header), and thousandths is gated by
// sign into [0, 50000] for raw < 0, exactly 50000 for raw == 0, and
// [50000, 100000] for raw > 0.
export function computeEvaluationScores(values) {
  const list = Array.isArray(values) ? values : [];
  const present = list.filter(finite).sort((a, b) => a - b);
  const count = present.length;
  const global = bounds(present);
  const neg = present.filter((v) => v < 0), negBounds = bounds(neg);
  const pos = present.filter((v) => v > 0), posBounds = bounds(pos);
  return list.map((value) => {
    if (!finite(value)) return null;
    const lower = global.lower(value);
    const ties = global.upper(value) - lower;
    const rank = count - lower - ties + 1;
    let thousandths;
    if (value === 0) {
      thousandths = 50000;
    } else if (value > 0) {
      const gl = posBounds.lower(value), gt = posBounds.upper(value) - gl;
      thousandths = 50000 + Math.round(scoreThousandths(gl, gt, pos.length) / 2);
    } else {
      const gl = negBounds.lower(value), gt = negBounds.upper(value) - gl;
      thousandths = Math.round(scoreThousandths(gl, gt, neg.length) / 2);
    }
    return { score: thousandths / 1000, thousandths, rank, ties, count };
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
