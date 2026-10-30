// Day-trade model: scored at 09:00 KST once the day's open is known, for a
// buy-at-open / sell-at-close session. Per symbol it predicts three returns
// from the open: close (session return), high (best intraday move) and low
// (worst intraday move).
// - Features: the 11 rank-model features of the prior 20 bars plus the day's
//   opening gap (open / prior close - 1), each ranked within the day's
//   cross-section (-0.5..+0.5).
// - Each target is split into the day's market level, fitted on the
//   cross-sectional mean opening gap (the market's own gap), and the
//   symbol's deviation from that level, fitted on the ranked features by
//   ridge (lambda DAYTRADE_LAMBDA).
// Trained on the DAYTRADE_TRAIN_DAYS sessions before the scored day; the
// scored day's close, high and low never enter the model.
import { RANK_FEATURE_NAMES, RANK_FEATURE_SESSIONS, rankFeatures } from "./rank-model.js";

export const DAYTRADE_MODEL = "daytrade_open_gap_rank_ridge_v1";
export const DAYTRADE_TRAIN_DAYS = 60;
export const DAYTRADE_LAMBDA = 0.1;
export const DAYTRADE_MIN_SYMBOLS = 300;
export const DAYTRADE_FEATURE_NAMES = Object.freeze([...RANK_FEATURE_NAMES, "open_gap"]);
export const DAYTRADE_TARGETS = Object.freeze(["close", "high", "low"]);
// Liquidity floor for picks: mean daily traded value of the prior 20 bars (KRW).
export const DAYTRADE_MIN_TURNOVER = 1_000_000_000;
export const DAYTRADE_TOP_N = 20;
// Assumed round-trip cost (transaction tax + fees), percent; unconfirmed.
export const DAYTRADE_COST_PCT = 0.2;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const quantile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };

function rankColumn(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = Array(values.length);
  order.forEach(([, i], k) => { out[i] = values.length > 1 ? k / (values.length - 1) - 0.5 : 0; });
  return out;
}

function solve(matrix, vector) {
  const n = vector.length, m = matrix.map((row, i) => [...row, vector[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-15) throw new Error("singular day-trade system");
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

// One day's cross-section. inputs: [{ symbol, prior (RANK_FEATURE_SESSIONS bars
// before the day, newest first), open, close?, high?, low? }]. Returns entries
// in symbol order with features, ranks, gap, turnover and (when present) the
// realised targets, plus the day's market gap.
export function daytradeCrossSection(inputs) {
  const entries = [];
  for (const input of [...inputs].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    if (!Array.isArray(input.prior) || input.prior.length !== RANK_FEATURE_SESSIONS || !(input.open > 0)) continue;
    const base = rankFeatures(input.prior);
    if (!base) continue;
    const gap = input.open / input.prior[0].close - 1;
    const turnover = mean(input.prior.map((b) => b.close * b.volume));
    const targets = [input.close, input.high, input.low].every((v) => v > 0) ? { close: input.close / input.open - 1, high: input.high / input.open - 1, low: input.low / input.open - 1 } : null;
    entries.push({ symbol: input.symbol, features: [...base, gap], gap, turnover, targets });
  }
  const columns = DAYTRADE_FEATURE_NAMES.map((_, j) => rankColumn(entries.map((e) => e.features[j])));
  entries.forEach((e, i) => { e.ranks = columns.map((c) => c[i]); });
  return { entries, marketGap: entries.length ? mean(entries.map((e) => e.gap)) : null };
}

// days: [{ date, entries, marketGap }] from daytradeCrossSection with targets,
// ascending; the last DAYTRADE_TRAIN_DAYS usable days are used. columns
// selects ranked features (default all); useMarket fits the market level on
// the market gap (false: constant level, as the rank model).
export function trainDaytradeModel(days, { columns = DAYTRADE_FEATURE_NAMES.map((_, j) => j), useMarket = true, lambda = DAYTRADE_LAMBDA } = {}) {
  const usable = days.filter((d) => d.entries.filter((e) => e.targets).length >= DAYTRADE_MIN_SYMBOLS).slice(-DAYTRADE_TRAIN_DAYS);
  if (usable.length < DAYTRADE_TRAIN_DAYS) return null;
  const k = columns.length + 1, model = { model: DAYTRADE_MODEL, columns, use_market: useMarket, lambda, train_first_date: usable[0].date, train_last_date: usable.at(-1).date, train_days: usable.length, targets: {} };
  for (const target of DAYTRADE_TARGETS) {
    const a = Array.from({ length: k }, () => Array(k).fill(0)), b = Array(k).fill(0), levels = [];
    let n = 0;
    for (const day of usable) {
      const rows = day.entries.filter((e) => e.targets), ys = rows.map((e) => e.targets[target]);
      const lo = quantile(ys, 0.01), hi = quantile(ys, 0.99), clipped = ys.map((y) => Math.max(lo, Math.min(hi, y)));
      const level = mean(clipped);
      levels.push({ x: day.marketGap, y: level });
      rows.forEach((e, i) => {
        const x = [1, ...columns.map((j) => e.ranks[j])], y = clipped[i] - level;
        for (let r = 0; r < k; r++) { b[r] += x[r] * y; for (let c = 0; c < k; c++) a[r][c] += x[r] * x[c]; }
        n++;
      });
    }
    for (let r = 1; r < k; r++) a[r][r] += lambda * n;
    const mx = mean(levels.map((l) => l.x)), my = mean(levels.map((l) => l.y));
    const vx = mean(levels.map((l) => (l.x - mx) ** 2));
    const slope = useMarket && vx > 0 ? mean(levels.map((l) => (l.x - mx) * (l.y - my))) / vx : 0;
    model.targets[target] = { level_intercept: my - slope * mx, level_slope: slope, weights: solve(a, b), samples: n };
  }
  return model;
}

export function isDaytradeModel(m) {
  return Boolean(m) && m.model === DAYTRADE_MODEL && Array.isArray(m.columns) && m.columns.every((j) => Number.isInteger(j) && j >= 0 && j < DAYTRADE_FEATURE_NAMES.length)
    && DAYTRADE_TARGETS.every((t) => m.targets?.[t] && finite(m.targets[t].level_intercept) && finite(m.targets[t].level_slope) && Array.isArray(m.targets[t].weights) && m.targets[t].weights.length === m.columns.length + 1 && m.targets[t].weights.every(finite));
}

// Predicted returns from the open (fractions) for every entry of one day.
export function predictDaytrade(model, { entries, marketGap }) {
  return entries.map((e) => {
    const out = { symbol: e.symbol, gap: e.gap, turnover: e.turnover, ranks: e.ranks };
    for (const target of DAYTRADE_TARGETS) {
      const t = model.targets[target], x = [1, ...model.columns.map((j) => e.ranks[j])];
      out[target] = t.level_intercept + t.level_slope * marketGap + x.reduce((s, v, i) => s + v * t.weights[i], 0);
    }
    return out;
  });
}

// Expected-close basis of a stock row scored at 09:00: everything needed to
// recompute predicted_return (and the row's expected_close) from the model.
export function daytradeCloseBasis({ model, prediction, marketGap, expectedOpen, actualOpen, priorClose, historyDates }) {
  const t = model.targets.close;
  return { model: DAYTRADE_MODEL, history_dates: [...historyDates], inputs: { expected_open: expectedOpen, actual_open: actualOpen, prior_close: priorClose, open_gap: prediction.gap, market_gap: marketGap, ranks: [...prediction.ranks], predicted_return: prediction.close,
    model_params: { model: model.model, columns: [...model.columns], train_first_date: model.train_first_date, train_last_date: model.train_last_date, train_days: model.train_days, ...(model.trained_at ? { trained_at: model.trained_at } : {}), level_intercept: t.level_intercept, level_slope: t.level_slope, weights: [...t.weights] } } };
}

export function daytradeClosePrediction(params, ranks, marketGap) {
  return params.level_intercept + params.level_slope * marketGap + [1, ...params.columns.map((j) => ranks[j])].reduce((s, v, i) => s + v * params.weights[i], 0);
}

// The day's picks: liquid symbols ranked by predicted close return.
export function daytradePicks(predictions, { topN = DAYTRADE_TOP_N, minTurnover = DAYTRADE_MIN_TURNOVER } = {}) {
  return predictions.filter((p) => p.turnover >= minTurnover).sort((a, b) => b.close - a.close || a.symbol.localeCompare(b.symbol)).slice(0, topN);
}

// Day cross-sections (with realised targets) for every date that has
// RANK_FEATURE_SESSIONS prior bars for enough symbols.
export function buildDays(observations) {
  const bySymbol = new Map();
  for (const o of observations) { if (!bySymbol.has(o.symbol)) bySymbol.set(o.symbol, new Map()); bySymbol.get(o.symbol).set(o.date, o); }
  const series = new Map([...bySymbol].map(([s, m]) => [s, [...m.values()].sort((a, b) => a.date.localeCompare(b.date))]));
  const inputsByDate = new Map();
  for (const [symbol, bars] of series) {
    for (let i = RANK_FEATURE_SESSIONS; i < bars.length; i++) {
      const bar = bars[i];
      if (!inputsByDate.has(bar.date)) inputsByDate.set(bar.date, []);
      inputsByDate.get(bar.date).push({ symbol, prior: bars.slice(i - RANK_FEATURE_SESSIONS, i).reverse(), open: bar.open, close: bar.close, high: bar.high, low: bar.low });
    }
  }
  return [...inputsByDate.keys()].sort().map((date) => ({ date, ...daytradeCrossSection(inputsByDate.get(date)) }));
}

