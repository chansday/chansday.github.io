import { mergePostCloseEvaluation } from "./post-close-overlay.js";
import { compareByExpectedReturn, rankingExpectedReturn, isNoTradeRow } from "./evaluation-contract.js";

// The top K are chosen before checking outcomes: missing outcomes never promote
// lower-ranked stocks into the portfolio or silently change its denominator.
export function summarizePerformance(snapshot, date) {
  if (snapshot?.meta?.run_date !== date || snapshot?.asOfDate !== date || snapshot?.meta?.run_stage !== "close-settlement" || !["ready", "partial"].includes(snapshot?.pipeline?.closeSettlement?.status) || snapshot?.meta?.test_only || snapshot?.meta?.historical_test || !Array.isArray(snapshot?.rows)) return null;
  const ranked = snapshot.rows.filter(row => Number.isFinite(rankingExpectedReturn(row))).sort(compareByExpectedReturn);
  const mean = k => {
    const top = ranked.slice(0, k);
    if (top.length !== k || top.some(row => isNoTradeRow(row) || !Number.isFinite(row.actual_open) || row.actual_open <= 0 || !Number.isFinite(row.actual_close) || row.actual_close <= 0)) return null;
    return top.reduce((sum, row) => sum + (row.actual_close / row.actual_open - 1) * 100, 0) / k;
  };
  return { date, top10: mean(10), top20: mean(20) };
}

// Match the ranking table: a snapshot already scored by the close model or
// already marked retrospective keeps its own expected values; otherwise apply
// the matching, validated retrospective record when present. Callers must
// distinguish a missing record from a read error.
export function usesRetrospectiveOverlay(snapshot) {
  return !snapshot?.meta?.retrospective_evaluation && !snapshot?.meta?.close_model;
}

export function summarizeDisplayedPerformance(snapshot, date, record = null) {
  return summarizePerformance(record && usesRetrospectiveOverlay(snapshot) ? mergePostCloseEvaluation(snapshot, record) : snapshot, date);
}

export function isNegativePerformance(value) {
  return Number.isFinite(value) && value < 0;
}

// Each series compounds independently. A missing daily result makes subsequent
// cumulative values unknown rather than treating the missing day as zero.
export function compoundPerformance(results, startDate = '2026-10-26', limit = 10) {
  const factors = { top10: 1, top20: 1 };
  const rows = results.filter(row => row.date >= startDate).sort((a, b) => a.date.localeCompare(b.date)).map(row => {
    const output = { date: row.date };
    for (const key of ['top10', 'top20']) {
      const value = row[key];
      factors[key] = factors[key] === null || !Number.isFinite(value) || value < -100 ? null : factors[key] * (1 + value / 100);
      output[key] = factors[key] === null ? null : (factors[key] - 1) * 100;
    }
    return output;
  });
  return rows.slice(-limit);
}


