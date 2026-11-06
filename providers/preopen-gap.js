import { daytradeCrossSection, predictDaytrade, daytradeCloseBasis, daytradeClosePrediction, isDaytradeModel } from "./daytrade-model.js";
import { PREOPEN_GAP_MODEL, preopenQuoteBasis, priorHistoryEstimate } from "./forecast-basis.js";
import { deriveExpectedReturn } from "./evaluation-contract.js";

// The day-trade model supplies only the marginal gap effect. The existing
// personal forecast remains the baseline, so this does not replace its model.
export function applyPreopenGap(rows, quotes, history) {
  const model = history?.daytrade_model;
  if (!isDaytradeModel(model) || !history?.return_history) return rows;
  const byQuote = new Map(quotes.filter(q => q.marketStatus === "PREOPEN" && q.quoteAt && q.openPrice > 0).map(q => [q.symbol, q]));
  const candidates = [];
  for (const row of rows) {
    const quote = byQuote.get(row.symbol), prior = history.return_history[row.symbol];
    if (!quote || !Array.isArray(prior) || prior.length !== 20 || !prior.every(b => b.high > 0 && b.low > 0 && b.volume > 0)) continue;
    const estimate = priorHistoryEstimate(history.sessions, row.symbol, { returnHistory: prior, forecastModel: history.forecast_model, rankForecast: history.rank_forecast });
    if (!(estimate?.expected_open > 0 && estimate.expected_close > 0 && estimate.close_basis)) continue;
    candidates.push({ symbol: row.symbol, prior, open: quote.openPrice, estimate, quote });
  }
  if (!candidates.length) return rows;
  const observed = daytradeCrossSection(candidates);
  // Equal gaps receive the same mid-rank; symbol order must not create a signal.
  const ordered = observed.entries.map(e => e.gap).sort((a, b) => a - b);
  for (const entry of observed.entries) {
    const first = ordered.findIndex(v => v === entry.gap);
    const last = ordered.lastIndexOf(entry.gap);
    entry.ranks[entry.ranks.length - 1] = ordered.length === 1 ? 0 : ((first + last) / 2) / (ordered.length - 1) - 0.5;
  }
  const observedPred = new Map(predictDaytrade(model, observed).map(p => [p.symbol, p]));
  const computed = new Map();
  for (const c of candidates) {
    const p = observedPred.get(c.symbol);
    if (!p) continue;
    const basis = daytradeCloseBasis({ model, prediction: p, marketGap: observed.marketGap, expectedOpen: c.open, actualOpen: c.open, priorClose: c.prior[0].close, historyDates: c.estimate.open_basis.history_dates });
    const zeroRanks = [...p.ranks];
    zeroRanks[zeroRanks.length - 1] = 0;
    const adjustment = p.close - daytradeClosePrediction(basis.inputs.model_params, zeroRanks, 0);
    const expected_close = Math.round((c.open * (c.estimate.expected_close / c.estimate.expected_open + adjustment) + Number.EPSILON) * 100) / 100;
    if (!(expected_close > 0)) continue;
    const quoteAt = c.quote.quoteAt.toISOString();
    const result = { expected_open: c.open, expected_open_source: {kind: "preopen_quote", recorded_at: quoteAt, history_dates: []}, expected_open_basis: preopenQuoteBasis({openPrice: c.open, quoteAt, marketStatus: "PREOPEN"}), expected_close, expected_close_basis: {model: PREOPEN_GAP_MODEL, history_dates: c.estimate.open_basis.history_dates, inputs: {prior_close: c.estimate.expected_open, baseline_close: c.estimate.expected_close, baseline_open_basis: c.estimate.open_basis, baseline_close_basis: c.estimate.close_basis, gap: p.gap, market_gap: observed.marketGap, ranks: p.ranks, zero_ranks: zeroRanks, model_params: basis.inputs.model_params, adjustment}} };
    result.expected_return = deriveExpectedReturn(result);
    computed.set(c.symbol, result);
  }
  return rows.map(row => computed.has(row.symbol) ? {...row, ...computed.get(row.symbol), quality: "naver_preopen_quote"} : row);
}
