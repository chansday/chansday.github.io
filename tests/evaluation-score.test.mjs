import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { computeEvaluationScores, evaluationScoreSummary, evaluationScoreTooltip, formatEvaluationScore, formatRawExpectedReturn, scoreThousandths, withEvaluationScores } from "../providers/evaluation-score.js";
import { deriveEvaluationError, deriveExpectedReturn } from "../providers/evaluation-contract.js";
import { validateRankingRows } from "../providers/provider-adapter.js";
import { sortRankingRows } from "../providers/ranking-sort.js";

const scores = (values) => computeEvaluationScores(values).map((entry) => (entry ? entry.score : null));

test("evaluation score is the mid-rank percentile: highest 100, lowest 0, higher return scores higher", () => {
  assert.deepEqual(scores([1, 3, 2, 5, 4]), [0, 50, 25, 100, 75]);
  const entries = computeEvaluationScores([0.5, -0.2, 0.9]);
  assert.deepEqual(entries.map((entry) => entry.rank), [2, 3, 1]);
  assert.deepEqual(entries.map((entry) => entry.count), [3, 3, 3]);
});

test("tied values share the average of the ranks they occupy", () => {
  // ascending ranks: 1, (2,3) -> 2.5, 4 ; score = (avg_rank - 1) / (N - 1) x 100
  assert.deepEqual(scores([1, 2, 2, 3]), [0, 50, 50, 100]);
  assert.deepEqual(scores([7, 7, 7]), [50, 50, 50]);
  assert.deepEqual(scores([1, 1, 2]), [25, 25, 100]);
  const entries = computeEvaluationScores([1, 2, 2, 3]);
  assert.deepEqual(entries.map((entry) => [entry.rank, entry.ties]), [[4, 1], [2, 2], [2, 2], [1, 1]]);
});

test("missing values get no score and are excluded from N", () => {
  const entries = computeEvaluationScores([null, 2, undefined, Number.NaN, 1, "3"]);
  assert.deepEqual(entries.map((entry) => entry?.score ?? null), [null, 100, null, null, 0, null]);
  assert.equal(entries[1].count, 2);
  assert.deepEqual(computeEvaluationScores([]), []);
  assert.deepEqual(computeEvaluationScores([null, null]), [null, null]);
});

test("a single scored symbol (N = 1) scores 50", () => {
  assert.deepEqual(scores([null, 0.04, null]), [null, 50, null]);
  assert.equal(computeEvaluationScores([0.04])[0].rank, 1);
});

test("scores use unrounded returns, so values tied at 0.00 are still ordered", () => {
  const rows = [
    { symbol: "A", expected_open: 10000, expected_close: 10003.71 },
    { symbol: "B", expected_open: 10000, expected_close: 10000.2 },
    { symbol: "C", expected_open: 10000, expected_close: 10000.1 },
  ];
  assert.deepEqual(rows.map(deriveExpectedReturn), [0.04, 0, 0]);
  const scored = withEvaluationScores(rows);
  assert.deepEqual(scored.map((row) => row.evaluation_score), [100, 50, 0]);
  assert.ok(Math.abs(scored[0].expected_return_raw - 0.0371) < 1e-9);
});

test("score display always has exactly 3 decimals and blanks missing values", () => {
  assert.equal(formatEvaluationScore(87.3416), "87.342");
  assert.equal(formatEvaluationScore(87.3414), "87.341");
  assert.equal(formatEvaluationScore(12.5625), "12.563", "exact binary half rounds up");
  assert.equal(formatEvaluationScore(100), "100.000");
  assert.equal(formatEvaluationScore(0), "0.000");
  assert.equal(formatEvaluationScore(50), "50.000");
  assert.equal(formatEvaluationScore((1 / 3) * 100), "33.333");
  assert.equal(formatEvaluationScore((2 / 3) * 100), "66.667");
  assert.equal(formatEvaluationScore(null), "—");
  assert.equal(formatEvaluationScore(Number.NaN), "—");
  for (const value of scores(Array.from({ length: 885 }, (_, index) => index % 97))) assert.match(formatEvaluationScore(value), /^\d{1,3}\.\d{3}$/);
});

test("tooltip keeps the original expected return", () => {
  const values = Array.from({ length: 885 }, (_, index) => 10 - index * 0.01);
  const entries = computeEvaluationScores(values);
  assert.equal(evaluationScoreTooltip(entries[112], 0.0371), "885종목 중 113위 · 원래 값 +0.0371%");
  const tied = computeEvaluationScores([1, 1, 0]);
  assert.equal(evaluationScoreTooltip(tied[0], 1), "3종목 중 공동 1위 · 원래 값 +1.0000%");
  assert.equal(formatRawExpectedReturn(-0.12345), "-0.1235%");
  assert.equal(formatRawExpectedReturn(0.00001), "0.0000%");
  assert.match(evaluationScoreTooltip(null, null), /계산하지 않았습니다/);
});

test("stored score fields are optional, keep expected_return and error unchanged, and pass row validation", () => {
  const base = { status: "valid", actual_return: null, actual_open: 100, actual_close: 101 };
  const rows = [
    { ...base, rank: 1, symbol: "005930", name: "A", expected_open: 100, expected_close: 100.5 },
    { ...base, rank: 2, symbol: "000660", name: "B", expected_open: 100, expected_close: 100.2 },
    { ...base, rank: 3, symbol: "035420", name: "C", expected_open: null, expected_close: null },
  ].map((row) => ({ ...row, expected_return: deriveExpectedReturn(row), error: deriveEvaluationError(row) }));
  assert.equal(validateRankingRows(rows).valid, true, "old rows without score fields stay valid");
  const scored = withEvaluationScores(rows);
  assert.equal(validateRankingRows(scored).valid, true);
  assert.deepEqual(scored.map((row) => row.expected_return), rows.map((row) => row.expected_return));
  assert.deepEqual(scored.map((row) => row.error), [0.5, 0.8, null]);
  assert.deepEqual(scored.map((row) => [row.evaluation_score, row.evaluation_score_rank, row.evaluation_score_count]), [[100, 1, 2], [0, 2, 2], [null, null, null]]);
  assert.equal(scored[2].expected_return_raw, null);
  assert.equal(validateRankingRows([{ ...scored[0], evaluation_score: 101 }]).valid, false);
  assert.equal(validateRankingRows([{ ...scored[0], evaluation_score_rank: 0 }]).valid, false);
  // Stored scores are rounded half up to 3 decimals (N = 4: 2/3 -> 66.667).
  const four = withEvaluationScores([4, 3, 2, 1].map((close, index) => ({ ...rows[0], symbol: `S${index}`, expected_close: 100 + close / 10 })));
  assert.deepEqual(four.map((row) => row.evaluation_score), [100, 66.667, 33.333, 0]);
  // Stale carried-over values are replaced on recomputation.
  assert.deepEqual(withEvaluationScores([{ ...scored[1], evaluation_score: 99 }]).map((row) => row.evaluation_score), [50]);
});

test("sorting by the 종목 평가 key orders exactly like the score", () => {
  const raw = [0.0371, -1.2, 0.0102, null, 2.5];
  const entries = computeEvaluationScores(raw);
  const rows = raw.map((value, index) => ({ symbol: `S${index}`, name: `S${index}`, expectedReturn: value === null ? null : Math.round(value * 100) / 100, expectedReturnRaw: value, evaluationScore: entries[index]?.score ?? null }));
  assert.deepEqual(sortRankingRows(rows, "expectedReturn").map((row) => row.evaluationScore), [100, 66.667, 33.333, 0, null]);
});

// Exact reference: half-up of (2L + E - 1) * 100000 / (2(N - 1)) in BigInt.
function referenceThousandths(numeratorUnits, count) {
  if (count === 1) return 50000n;
  const numerator = BigInt(numeratorUnits) * 100000n;
  const denominator = BigInt(2 * (count - 1));
  return (2n * numerator + denominator) / (2n * denominator);
}

test("half-up rounding to 3 decimals is exact for every rank/tie combination with N <= 1500", () => {
  // k = 2L + E - 1 takes every value 0..2(N-1); E = 1 or 2 reaches each k, and
  // larger tie groups only produce the same numerators. 2,250,000 exact checks.
  let checked = 0;
  for (let count = 1; count <= 1500; count += 1) {
    const maxK = count === 1 ? 0 : 2 * (count - 1);
    for (let k = 0; k <= maxK; k += 1) {
      const lower = Math.floor(k / 2);
      const ties = k - 2 * lower + 1;
      const actual = scoreThousandths(lower, ties, count);
      if (BigInt(actual) !== referenceThousandths(k, count)) assert.fail(`N=${count} k=${k}: ${actual}`);
      checked += 1;
    }
  }
  assert.equal(checked, 1 + 1499 * 1501);
});

test("N = 161, k = 23 (score 7.1875) rounds half up to 7.188 in storage and display", () => {
  assert.equal(scoreThousandths(11, 2, 161), 7188);
  // 161 values: 11 below a tied pair, so L = 11, E = 2.
  const values = Array.from({ length: 161 }, (_, index) => index);
  values[12] = 11;
  const entry = computeEvaluationScores(values)[11];
  assert.deepEqual([entry.thousandths, entry.score, entry.ties], [7188, 7.188, 2]);
  assert.equal(formatEvaluationScore(entry.score), "7.188");
  const rows = values.map((value, index) => ({ symbol: `S${index}`, expected_open: 100, expected_close: 100 + value / 1000 }));
  assert.equal(withEvaluationScores(rows)[11].evaluation_score, 7.188);
});

test("display strings come from the integer thousandths for every N <= 1500 score", () => {
  for (const count of [2, 3, 7, 161, 885, 1499, 1500]) {
    const entries = computeEvaluationScores(Array.from({ length: count }, (_, index) => index));
    for (const entry of entries) {
      const text = formatEvaluationScore(entry.score);
      assert.equal(text, `${Math.floor(entry.thousandths / 1000)}.${String(entry.thousandths % 1000).padStart(3, "0")}`);
    }
  }
});

test("visible rank summary for touch layouts", () => {
  const values = Array.from({ length: 885 }, (_, index) => 10 - index * 0.01);
  const entries = computeEvaluationScores(values);
  assert.equal(evaluationScoreSummary(entries[112], 0.0371), "113위/885 · +0.0371%");
  assert.equal(evaluationScoreSummary(computeEvaluationScores([1, 1, 0])[0], 1), "공동 1위/3 · +1.0000%");
  assert.equal(evaluationScoreSummary(null, null), "");
});

test("mobile card and detail panel show the rank summary as visible escaped text", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /rowMetric\("종목 평가", formatEvaluationScore\(row\.evaluationScore\), toneClass\(row\.expectedReturn\), evaluationTitle\(row\), evaluationNote\(row\)\)/);
  assert.match(app, /<small class="evaluation-note">\$\{escapeText\(note\)\}<\/small>/);
  assert.match(app, /setText\(document\.getElementById\("selected-evaluation-note"\), evaluationNote\(row\)\)/);
  assert.match(html, /<strong id="selected-expected-return">—<\/strong><small id="selected-evaluation-note" class="evaluation-note"><\/small>/);
});

test("UI labels the column 종목 평가 with 3-decimal scores and no integer-display aria-label", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<th scope="col"[^>]*>종목 평가<\/th>/);
  assert.match(html, /<span[^>]*>종목 평가<\/span><strong id="selected-expected-return">/);
  assert.match(html, /<option value="expectedReturn" selected>종목 평가 높은 순<\/option>/);
  assert.doesNotMatch(html, /퍼센트 단위 정수 표시/);
  assert.doesNotMatch(app, /퍼센트 단위 정수 표시/);
  assert.doesNotMatch(html, />예상 수익률<\/(th|span)>/);
  assert.match(app, /rowMetric\("종목 평가", formatEvaluationScore\(row\.evaluationScore\)/);
  assert.match(app, /aria-label="종목 평가 \$\{formatEvaluationScore\(row\.evaluationScore\)\}\. 0–100 백분위 점수, 소수 셋째 자리 표시/);
  assert.match(app, /attachEvaluationScores\(Array\.isArray\(data\?\.rows\) \? data\.rows\.map\(normalizeRow\) : \[\]\)/);
});

test("schema declares the score fields as optional row properties", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/market-snapshot.schema.json", import.meta.url), "utf8"));
  const row = schema.$defs.rankingRow;
  for (const field of ["expected_return_raw", "evaluation_score", "evaluation_score_rank", "evaluation_score_count"]) {
    assert.ok(row.properties[field], field);
    assert.equal(row.required.includes(field), false, field);
  }
  assert.equal(row.properties.evaluation_score.maximum, 100);
});
