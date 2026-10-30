// Shared prior-history estimate and the provenance ("basis") stored with it.
// Every number in a basis is an input or intermediate value actually used in
// the calculation; nothing is synthesized. Sessions are newest first and never
// include the target date.
import { FEATURE_SESSIONS, RIDGE_MODEL, isRidgeModel, ridgeFeatures, ridgePredict } from "./ridge-model.js";
import { RANK_FEATURE_SESSIONS, RANK_MODEL, isRankModel, rankFeatures, rankPredict } from "./rank-model.js";
import { DAYTRADE_FEATURE_NAMES, DAYTRADE_MODEL, daytradeClosePrediction } from "./daytrade-model.js";

export const PREOPEN_QUOTE_MODEL = "naver_preopen_quote_open_v1";
export const OPEN_GAP_MODEL = "prior_3_sessions_open_gap_mean_capped_5pct";
// Same identifier as the post-close retrospective: expected_close applies the
// capped mean of the three prior session returns to the gap-based opening.
export const CLOSE_SESSION_MODEL = "prior_3_sessions_gap_and_session_mean_capped_5pct";
export const BASIS_CAP = 0.05;
// Expected-close model from 2026-10-30. Backtest 2026-07-30..10-28 (57 sessions,
// 913 KOSPI symbols, next-day open->close return): MAE 2.25% -> 1.97%, rank IC
// 0.022 (t 1.57) -> 0.030 (t 2.73), top-20 realized -0.22% -> +0.17% versus the
// 3-session model. Up to 20 prior session returns; the top and bottom
// floor(n / 10) are dropped; the trimmed mean is shrunk by t^2 / (1 + t^2)
// (t = mean / standard error) and capped at +/-1%.
export const CLOSE_SHRUNK_MODEL = "prior_20_sessions_trimmed_shrunk_mean_capped_1pct";
export const RETURN_HISTORY_SESSIONS = 20;
export const SHRUNK_CAP = 0.01;

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const clamp = (value) => Math.max(-BASIS_CAP, Math.min(BASIS_CAP, value));
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

// Trimmed, shrunk mean of session returns; every intermediate is returned so the
// stored basis can be recomputed exactly.
export function shrunkSessionReturn(ratios) {
  const n = ratios.length, trim = Math.floor(n / 10);
  const kept = [...ratios].sort((a, b) => a - b).slice(trim, n - trim);
  const mean = kept.reduce((sum, r) => sum + r, 0) / kept.length;
  const sd = Math.sqrt(kept.reduce((sum, r) => sum + (r - mean) ** 2, 0) / kept.length);
  const se = sd / Math.sqrt(kept.length);
  const t = se > 0 ? mean / se : 0;
  const weight = se > 0 ? (t * t) / (1 + t * t) : 0;
  const applied = Math.max(-SHRUNK_CAP, Math.min(SHRUNK_CAP, mean * weight));
  return { trim_count: trim, trimmed_mean: mean, standard_error: se, t_stat: t, shrink_weight: weight, applied_session_return: applied };
}

// returnHistory: the symbol's prior candles ({ date, open, close }, newest
// first, first three equal to `sessions`). Without it the 3-session close model
// is kept (caches collected before the new model, post-close retrospective).
// rankForecast: the cache's { model, predictions } (verified across the whole
// cross-section when the cache was loaded); preferred over forecastModel.
export function priorHistoryEstimate(sessions, symbol, { returnHistory = null, forecastModel = null, rankForecast = null } = {}) {
  if (!Array.isArray(sessions) || sessions.length !== 3) return null;
  const h = sessions.map((session) => session?.rows?.find((row) => row.symbol === symbol));
  if (h.some((row) => !row || !positive(row.open) || !positive(row.close) || !positive(row.volume))) return null;
  const dates = sessions.map((session) => session.date);
  const gaps = [0, 1].map((i) => ({ date: dates[i], open: h[i].open, previous_date: dates[i + 1], previous_close: h[i + 1].close, ratio: h[i].open / h[i + 1].close - 1 }));
  const meanGap = (gaps[0].ratio + gaps[1].ratio) / 2;
  const appliedGap = clamp(meanGap);
  const expectedOpen = round(h[0].close * (1 + appliedGap));
  const sessionReturns = h.map((row, i) => ({ date: dates[i], open: row.open, close: row.close, ratio: row.close / row.open - 1 }));
  const meanSession = sessionReturns.reduce((sum, item) => sum + item.ratio, 0) / 3;
  const appliedSession = clamp(meanSession);
  const candles = Array.isArray(returnHistory) && returnHistory.length >= 3 && returnHistory.length <= RETURN_HISTORY_SESSIONS
    && returnHistory.every((c, k) => c && DATE.test(c.date) && positive(c.open) && positive(c.close) && (k >= 3 || (c.date === dates[k] && c.open === h[k].open && c.close === h[k].close)) && (k === 0 || c.date < returnHistory[k - 1].date))
    ? returnHistory : null;
  const rank = rankForecast?.predictions?.[symbol];
  if (candles && candles.length === RANK_FEATURE_SESSIONS && rank && isRankModel(rankForecast.model) && rankForecast.model.train_last_date <= dates[0] && candles.every((c) => positive(c.high) && positive(c.low) && positive(c.volume))) {
    const bars = candles.map((c) => ({ date: c.date, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume }));
    const predicted = rankPredict(rankForecast.model, rank.ranks);
    return {
      expected_open: expectedOpen,
      expected_close: round(expectedOpen * (1 + predicted)),
      open_basis: { model: OPEN_GAP_MODEL, history_dates: dates, inputs: { prior_close_date: dates[0], prior_close: h[0].close, gaps, mean_gap: meanGap, applied_gap: appliedGap, cap: BASIS_CAP } },
      close_basis: { model: RANK_MODEL, history_dates: dates, inputs: { expected_open: expectedOpen, candles: bars, features: rank.features, ranks: rank.ranks, predicted_return: predicted, model_params: rankForecast.model } },
    };
  }
  // The day's model decides the scale of every expected return: a symbol the
  // rank (or ridge) model cannot score gets no expected close rather than a
  // value from a differently scaled fallback that would distort the ranking.
  const openOnly = () => ({ expected_open: expectedOpen, expected_close: null, open_basis: { model: OPEN_GAP_MODEL, history_dates: dates, inputs: { prior_close_date: dates[0], prior_close: h[0].close, gaps, mean_gap: meanGap, applied_gap: appliedGap, cap: BASIS_CAP } }, close_basis: null });
  if (isRankModel(rankForecast?.model)) return openOnly();
  if (candles && candles.length === FEATURE_SESSIONS && isRidgeModel(forecastModel) && forecastModel.train_last_date <= dates[0]) {
    const returns = candles.map((c) => ({ date: c.date, open: c.open, close: c.close, ratio: c.close / c.open - 1 }));
    const features = ridgeFeatures(candles);
    const { clipped, predicted } = ridgePredict(forecastModel, features);
    return {
      expected_open: expectedOpen,
      expected_close: round(expectedOpen * (1 + predicted)),
      open_basis: { model: OPEN_GAP_MODEL, history_dates: dates, inputs: { prior_close_date: dates[0], prior_close: h[0].close, gaps, mean_gap: meanGap, applied_gap: appliedGap, cap: BASIS_CAP } },
      close_basis: { model: RIDGE_MODEL, history_dates: dates, inputs: { expected_open: expectedOpen, session_returns: returns, features, clipped_features: clipped, predicted_return: predicted, model_params: forecastModel } },
    };
  }
  if (isRidgeModel(forecastModel)) return openOnly();
  if (candles) {
    const returns = candles.map((c) => ({ date: c.date, open: c.open, close: c.close, ratio: c.close / c.open - 1 }));
    const stats = shrunkSessionReturn(returns.map((r) => r.ratio));
    const shrunkClose = round(expectedOpen * (1 + stats.applied_session_return));
    return {
      expected_open: expectedOpen,
      expected_close: shrunkClose,
      open_basis: { model: OPEN_GAP_MODEL, history_dates: dates, inputs: { prior_close_date: dates[0], prior_close: h[0].close, gaps, mean_gap: meanGap, applied_gap: appliedGap, cap: BASIS_CAP } },
      close_basis: { model: CLOSE_SHRUNK_MODEL, history_dates: dates, inputs: { expected_open: expectedOpen, session_returns: returns, ...stats, cap: SHRUNK_CAP } },
    };
  }
  const expectedClose = round(expectedOpen * (1 + appliedSession));
  return {
    expected_open: expectedOpen,
    expected_close: expectedClose,
    open_basis: { model: OPEN_GAP_MODEL, history_dates: dates, inputs: { prior_close_date: dates[0], prior_close: h[0].close, gaps, mean_gap: meanGap, applied_gap: appliedGap, cap: BASIS_CAP } },
    close_basis: { model: CLOSE_SESSION_MODEL, history_dates: dates, inputs: { expected_open: expectedOpen, session_returns: sessionReturns, mean_session_return: meanSession, applied_session_return: appliedSession, cap: BASIS_CAP } },
  };
}

export function preopenQuoteBasis({ openPrice, quoteAt, marketStatus }) {
  return { model: PREOPEN_QUOTE_MODEL, history_dates: [], inputs: { open_price: openPrice, quote_at: quoteAt, market_status: marketStatus } };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Stored ratios are recomputed from their own stored prices; the tolerance only
// absorbs floating-point representation, not rounding of the inputs.
const RATIO_TOLERANCE = 1e-9;
const near = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= RATIO_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const exactKeys = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).sort().join(",") === [...keys].sort().join(",");

function validHistoryDates(dates, length) {
  return Array.isArray(dates) && dates.length === length && dates.every((d, i) => typeof d === "string" && DATE.test(d) && (i === 0 || d < dates[i - 1]));
}

// Structural validation used by the snapshot contract.
export function isOpenBasis(basis, row, { asOfDate = null } = {}) {
  if (!exactKeys(basis, ["model", "history_dates", "inputs"]) || !positive(row?.expected_open) || !row.expected_open_source) return false;
  const src = row.expected_open_source, i = basis.inputs;
  if (basis.model === PREOPEN_QUOTE_MODEL) {
    return src.kind === "preopen_quote" && validHistoryDates(basis.history_dates, 0) && exactKeys(i, ["open_price", "quote_at", "market_status"])
      && positive(i.open_price) && i.open_price === row.expected_open && typeof i.quote_at === "string" && Number.isFinite(Date.parse(i.quote_at)) && i.market_status === "PREOPEN";
  }
  if (basis.model === OPEN_GAP_MODEL) {
    if (src.kind === "preopen_quote" || !validHistoryDates(basis.history_dates, 3) || basis.history_dates.join() !== src.history_dates.join()) return false;
    if (!exactKeys(i, ["prior_close_date", "prior_close", "gaps", "mean_gap", "applied_gap", "cap"]) || i.prior_close_date !== basis.history_dates[0] || !positive(i.prior_close) || !finite(i.mean_gap) || !finite(i.applied_gap) || i.cap !== BASIS_CAP) return false;
    if (asOfDate && !(basis.history_dates[0] < asOfDate)) return false;
    if (!Array.isArray(i.gaps) || i.gaps.length !== 2 || !i.gaps.every((g, k) => exactKeys(g, ["date", "open", "previous_date", "previous_close", "ratio"]) && g.date === basis.history_dates[k] && g.previous_date === basis.history_dates[k + 1] && positive(g.open) && positive(g.previous_close) && near(g.ratio, g.open / g.previous_close - 1))) return false;
    return near(i.mean_gap, (i.gaps[0].ratio + i.gaps[1].ratio) / 2) && i.applied_gap === clamp(i.mean_gap) && row.expected_open === round(i.prior_close * (1 + i.applied_gap));
  }
  return false;
}

function isShrunkCloseBasis(basis, row, asOfDate) {
  const i = basis.inputs;
  if (!validHistoryDates(basis.history_dates, 3) || !exactKeys(i, ["expected_open", "session_returns", "trim_count", "trimmed_mean", "standard_error", "t_stat", "shrink_weight", "applied_session_return", "cap"]) || i.cap !== SHRUNK_CAP || !positive(i.expected_open) || i.expected_open !== row.expected_open) return false;
  if (asOfDate && !(basis.history_dates[0] < asOfDate)) return false;
  const s = i.session_returns;
  if (!Array.isArray(s) || s.length < 3 || s.length > RETURN_HISTORY_SESSIONS || !s.every((x, k) => exactKeys(x, ["date", "open", "close", "ratio"]) && DATE.test(x.date) && (k >= 3 ? x.date < s[k - 1].date : x.date === basis.history_dates[k]) && positive(x.open) && positive(x.close) && near(x.ratio, x.close / x.open - 1))) return false;
  const stats = shrunkSessionReturn(s.map((x) => x.ratio));
  if (i.trim_count !== stats.trim_count || !["trimmed_mean", "standard_error", "t_stat", "shrink_weight", "applied_session_return"].every((k) => near(i[k], stats[k])) || Math.abs(i.applied_session_return) > SHRUNK_CAP) return false;
  if (row.expected_close !== round(i.expected_open * (1 + i.applied_session_return))) return false;
  const o = row.expected_open_basis?.inputs;
  if (!o || !Array.isArray(o.gaps) || o.gaps.length !== 2) return false;
  const [s0, s1, s2] = s;
  return o.prior_close === s0.close && o.gaps[0].open === s0.open && o.gaps[0].previous_close === s1.close && o.gaps[1].open === s1.open && o.gaps[1].previous_close === s2.close;
}

// Ranks are relative to the morning cross-section and were re-verified when the
// cache was loaded; here the features are recomputed from the stored bars and
// the prediction from the stored ranks and weights.
function isRankCloseBasis(basis, row, asOfDate) {
  const i = basis.inputs;
  if (!validHistoryDates(basis.history_dates, 3) || !exactKeys(i, ["expected_open", "candles", "features", "ranks", "predicted_return", "model_params"]) || !positive(i.expected_open) || i.expected_open !== row.expected_open) return false;
  if (asOfDate && !(basis.history_dates[0] < asOfDate)) return false;
  const m = i.model_params, c = i.candles;
  if (!isRankModel(m) || !(m.train_last_date <= basis.history_dates[0])) return false;
  if (!Array.isArray(c) || c.length !== RANK_FEATURE_SESSIONS || !c.every((x, k) => exactKeys(x, ["date", "open", "close", "high", "low", "volume"]) && DATE.test(x.date) && (k >= 3 ? x.date < c[k - 1].date : x.date === basis.history_dates[k]))) return false;
  const features = rankFeatures(c);
  if (!features || !Array.isArray(i.features) || !features.every((v, k) => near(v, i.features[k]))) return false;
  if (!Array.isArray(i.ranks) || i.ranks.length !== features.length || !i.ranks.every((v) => finite(v) && v >= -0.5 && v <= 0.5)) return false;
  if (!near(i.predicted_return, rankPredict(m, i.ranks)) || row.expected_close !== round(i.expected_open * (1 + i.predicted_return))) return false;
  const o = row.expected_open_basis?.inputs;
  if (!o || !Array.isArray(o.gaps) || o.gaps.length !== 2) return false;
  const [s0, s1, s2] = c;
  return o.prior_close === s0.close && o.gaps[0].open === s0.open && o.gaps[0].previous_close === s1.close && o.gaps[1].open === s1.open && o.gaps[1].previous_close === s2.close;
}

function isRidgeCloseBasis(basis, row, asOfDate) {
  const i = basis.inputs;
  if (!validHistoryDates(basis.history_dates, 3) || !exactKeys(i, ["expected_open", "session_returns", "features", "clipped_features", "predicted_return", "model_params"]) || !positive(i.expected_open) || i.expected_open !== row.expected_open) return false;
  if (asOfDate && !(basis.history_dates[0] < asOfDate)) return false;
  const m = i.model_params, s = i.session_returns;
  if (!isRidgeModel(m) || !(m.train_last_date <= basis.history_dates[0])) return false;
  if (!Array.isArray(s) || s.length !== FEATURE_SESSIONS || !s.every((x, k) => exactKeys(x, ["date", "open", "close", "ratio"]) && DATE.test(x.date) && (k >= 3 ? x.date < s[k - 1].date : x.date === basis.history_dates[k]) && positive(x.open) && positive(x.close) && near(x.ratio, x.close / x.open - 1))) return false;
  const features = ridgeFeatures(s);
  if (!features || !Array.isArray(i.features) || !features.every((v, k) => near(v, i.features[k]))) return false;
  const { clipped, predicted } = ridgePredict(m, features);
  if (!Array.isArray(i.clipped_features) || !clipped.every((v, k) => near(v, i.clipped_features[k])) || !near(i.predicted_return, predicted)) return false;
  if (row.expected_close !== round(i.expected_open * (1 + i.predicted_return))) return false;
  const o = row.expected_open_basis?.inputs;
  if (!o || !Array.isArray(o.gaps) || o.gaps.length !== 2) return false;
  const [s0, s1, s2] = s;
  return o.prior_close === s0.close && o.gaps[0].open === s0.open && o.gaps[0].previous_close === s1.close && o.gaps[1].open === s1.open && o.gaps[1].previous_close === s2.close;
}

// Day-trade close (scored at 09:00 with the actual open, whatever the expected
// open's source): the stored ranks and
// model coefficients must reproduce predicted_return, and expected_close is the
// expected open moved by it, so expected_return equals the model's open->close.
function isDaytradeCloseBasis(basis, row, asOfDate) {
  const i = basis.inputs, m = i?.model_params;
  if (!validHistoryDates(basis.history_dates, 3) || !exactKeys(i, ["expected_open", "actual_open", "prior_close", "open_gap", "market_gap", "ranks", "predicted_return", "model_params"]) || !positive(i.expected_open) || i.expected_open !== row.expected_open || !positive(i.actual_open) || !positive(i.prior_close)) return false;
  if (asOfDate && !(basis.history_dates[0] < asOfDate)) return false;
  if (!m || m.model !== DAYTRADE_MODEL || !Array.isArray(m.columns) || !m.columns.every((j) => Number.isInteger(j) && j >= 0 && j < DAYTRADE_FEATURE_NAMES.length) || !Array.isArray(m.weights) || m.weights.length !== m.columns.length + 1 || ![m.level_intercept, m.level_slope, ...m.weights].every(finite) || !DATE.test(m.train_last_date) || !(m.train_last_date <= basis.history_dates[0])) return false;
  if (!Array.isArray(i.ranks) || i.ranks.length !== DAYTRADE_FEATURE_NAMES.length || !i.ranks.every((v) => finite(v) && v >= -0.5 && v <= 0.5) || !finite(i.market_gap)) return false;
  if (!near(i.open_gap, i.actual_open / i.prior_close - 1)) return false;
  return near(i.predicted_return, daytradeClosePrediction(m, i.ranks, i.market_gap)) && row.expected_close === round(i.expected_open * (1 + i.predicted_return));
}

export function isCloseBasis(basis, row, { asOfDate = null } = {}) {
  if (exactKeys(basis, ["model", "history_dates", "inputs"]) && basis.model === DAYTRADE_MODEL) return positive(row?.expected_close) && isDaytradeCloseBasis(basis, row, asOfDate);
  if (exactKeys(basis, ["model", "history_dates", "inputs"]) && basis.model === RANK_MODEL) return positive(row?.expected_close) && isRankCloseBasis(basis, row, asOfDate);
  if (exactKeys(basis, ["model", "history_dates", "inputs"]) && basis.model === RIDGE_MODEL) return positive(row?.expected_close) && isRidgeCloseBasis(basis, row, asOfDate);
  if (exactKeys(basis, ["model", "history_dates", "inputs"]) && basis.model === CLOSE_SHRUNK_MODEL) return positive(row?.expected_close) && isShrunkCloseBasis(basis, row, asOfDate);
  if (!exactKeys(basis, ["model", "history_dates", "inputs"]) || basis.model !== CLOSE_SESSION_MODEL || !positive(row?.expected_close) || !validHistoryDates(basis.history_dates, 3)) return false;
  const i = basis.inputs;
  if (!exactKeys(i, ["expected_open", "session_returns", "mean_session_return", "applied_session_return", "cap"]) || i.cap !== BASIS_CAP || !positive(i.expected_open) || i.expected_open !== row.expected_open) return false;
  if (asOfDate && !(basis.history_dates[0] < asOfDate)) return false;
  if (!Array.isArray(i.session_returns) || i.session_returns.length !== 3 || !i.session_returns.every((s, k) => exactKeys(s, ["date", "open", "close", "ratio"]) && s.date === basis.history_dates[k] && positive(s.open) && positive(s.close) && near(s.ratio, s.close / s.open - 1))) return false;
  if (!near(i.mean_session_return, i.session_returns.reduce((sum, s) => sum + s.ratio, 0) / 3) || i.applied_session_return !== clamp(i.mean_session_return) || row.expected_close !== round(i.expected_open * (1 + i.applied_session_return))) return false;
  // Both bases describe the same three daily bars: prices must agree across them.
  const o = row.expected_open_basis?.inputs;
  if (!o || !Array.isArray(o.gaps) || o.gaps.length !== 2) return false;
  const [s0, s1, s2] = i.session_returns;
  return o.prior_close === s0.close && o.gaps[0].open === s0.open && o.gaps[0].previous_close === s1.close && o.gaps[1].open === s1.open && o.gaps[1].previous_close === s2.close;
}
