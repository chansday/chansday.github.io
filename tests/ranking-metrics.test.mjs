import test from "node:test";
import assert from "node:assert/strict";
import { RANKING_SCORE_BUCKETS, RANKING_TOP_K, buildEvaluationSummary, buildRankingMetrics, isEvaluationSummary, isRankingMetrics } from "../providers/evaluation-contract.js";

// expected_open 100, so expected return % = expected_close - 100; same for actual.
const row = (symbol, expected, actual) => ({ symbol, expected_open: 100, expected_close: 100 + expected, actual_open: 100, actual_close: 100 + actual, error: actual - expected });

test("perfect ordering gives rank IC 1, full hit rate and ascending buckets", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(String(i).padStart(6, "0"), i - 15, 2 * (i - 15)));
  const metrics = buildRankingMetrics(rows);
  assert.equal(metrics.sample_count, 30);
  assert.equal(metrics.rank_ic, 1);
  assert.equal(metrics.hit_rate, 1);
  assert.equal(metrics.calibration_slope, 2);
  assert.equal(metrics.top_k.k, RANKING_TOP_K);
  assert.equal(metrics.score_buckets.length, RANKING_SCORE_BUCKETS);
  assert.deepEqual(metrics.score_buckets.map((b) => b.count), Array(10).fill(3));
  assert.ok(metrics.score_buckets.every((b, i, all) => i === 0 || b.mean_session_return > all[i - 1].mean_session_return));
  assert.equal(metrics.bucket_spread, metrics.score_buckets[9].mean_session_return - metrics.score_buckets[0].mean_session_return);
  assert.ok(metrics.top_k.excess_return > 0);
  assert.equal(isRankingMetrics(metrics), true);
});

test("reversed ordering gives rank IC -1 and ties use average ranks", () => {
  const reversed = Array.from({ length: 5 }, (_, i) => row(`A${i}`, i, -i));
  assert.equal(buildRankingMetrics(reversed).rank_ic, -1);
  const tied = [row("A", 1, 1), row("B", 1, 2), row("C", 2, 3)];
  assert.equal(buildRankingMetrics(tied).rank_ic, 0.866); // sqrt(3)/2 with tied expected ranks 1.5, 1.5, 3
});

test("small or degenerate samples return nulls instead of numbers", () => {
  assert.deepEqual(buildRankingMetrics([row("A", 1, 1)]), { sample_count: 1, rank_ic: null, hit_rate: null, calibration_slope: null, top_k: null, score_buckets: [], bucket_spread: null });
  const flat = buildRankingMetrics([row("A", 1, 1), row("B", 1, -1)]);
  assert.equal(flat.rank_ic, null); assert.equal(flat.calibration_slope, null); assert.equal(flat.hit_rate, 0.5);
  assert.equal(flat.top_k, null); assert.deepEqual(flat.score_buckets, []);
});

test("pending and no-trade rows are excluded; summary carries metrics and old summaries stay valid", () => {
  const rows = [row("A", 1, 2), row("B", -1, -2), { symbol: "C", expected_open: 100, expected_close: null, actual_open: 100, actual_close: 101 }, { ...row("D", 3, 3), trading_status: "no_trade_observed" }];
  const summary = buildEvaluationSummary(rows);
  assert.equal(summary.ranking_metrics.sample_count, 2);
  assert.equal(summary.ranking_metrics.rank_ic, 1);
  assert.equal(isEvaluationSummary(summary), true);
  const { ranking_metrics: _omit, ...legacy } = summary;
  assert.equal(isEvaluationSummary(legacy), true);
  assert.equal(isEvaluationSummary({ ...summary, ranking_metrics: { ...summary.ranking_metrics, rank_ic: "x" } }), false);
});
