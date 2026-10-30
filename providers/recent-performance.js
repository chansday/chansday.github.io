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

// Match the ranking table: apply the matching, validated retrospective record
// when present; callers must distinguish a missing record from a read error.
export function summarizeDisplayedPerformance(snapshot, date, record = null) {
  return summarizePerformance(record ? mergePostCloseEvaluation(snapshot, record) : snapshot, date);
}

export function isNegativePerformance(value) {
  return Number.isFinite(value) && value < 0;
}
