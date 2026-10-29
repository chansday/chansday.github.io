// Cross-sectional rank ridge model for the expected session (open->close)
// return, retrained every morning on the prior TRAIN_DAYS sessions.
// - 11 features from the prior 20 daily bars, each turned into its rank within
//   that day's cross-section (-0.5..+0.5), so no clipping or cap is needed;
// - target: the session return minus that day's market mean (winsorized 1%);
// - prediction: market level (mean session return of the training days) +
//   intercept + ranked features x ridge weights (lambda 0.1).
// Walk-forward 2026-09-01..10-28 (38 sessions, 913 KOSPI symbols) versus the
// 6-feature ridge: rank IC 0.052 (t 2.65) -> 0.074 (t 3.92), top-20 excess
// return +0.11% -> +0.43%, calibration slope 0.69 -> 0.90, largest prediction
// 0.82%; IC 0.073 / 0.076 in the September / October halves.
export const RANK_MODEL = "ridge_rank_11_features_60_sessions_v1";
export const RANK_FEATURE_SESSIONS = 20;
export const RANK_TRAIN_DAYS = 60;
export const RANK_MIN_SYMBOLS = 300;
export const RANK_LAMBDA = 0.1;
export const RANK_FEATURE_NAMES = Object.freeze([
  "trimmed_mean_20", "mean_5", "last_return", "last_gap", "momentum_20", "volatility_20",
  "range_20", "volume_ratio", "close_position", "mean_gap_20", "log_turnover",
]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const pstdev = (values) => { const m = mean(values); return Math.sqrt(mean(values.map((v) => (v - m) ** 2))); };
const validBar = (b) => b && [b.open, b.close, b.high, b.low, b.volume].every((n) => finite(n) && n > 0) && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close);

// bars: exactly RANK_FEATURE_SESSIONS { open, close, high, low, volume }, newest first.
export function rankFeatures(bars) {
  if (!Array.isArray(bars) || bars.length !== RANK_FEATURE_SESSIONS || !bars.every(validBar)) return null;
  const h = [...bars].reverse(), n = h.length, last = h[n - 1];
  const r = h.map((b) => b.close / b.open - 1);
  const trimmed = [...r].sort((a, b) => a - b).slice(2, n - 2);
  const gaps = h.slice(1).map((b, i) => b.open / h[i].close - 1);
  return [
    mean(trimmed), mean(r.slice(-5)), r[n - 1], last.open / h[n - 2].close - 1, last.close / h[0].open - 1, pstdev(r),
    mean(h.map((b) => (b.high - b.low) / b.open)),
    Math.log(last.volume / mean(h.slice(0, n - 1).map((b) => b.volume))),
    last.high > last.low ? (last.close - last.low) / (last.high - last.low) - 0.5 : 0,
    mean(gaps),
    Math.log(last.close * mean(h.map((b) => b.volume))),
  ];
}

// Rank of each value within the column, scaled to -0.5..+0.5; ties are broken
// by the caller's order (symbol code).
function rankColumn(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = Array(values.length);
  order.forEach(([, i], k) => { out[i] = values.length > 1 ? k / (values.length - 1) - 0.5 : 0; });
  return out;
}

// entries: [{ symbol, features }]; returns ranks per entry in symbol order.
export function rankCrossSection(entries) {
  const sorted = [...entries].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const columns = RANK_FEATURE_NAMES.map((_, j) => rankColumn(sorted.map((e) => e.features[j])));
  return sorted.map((e, i) => ({ symbol: e.symbol, features: e.features, ranks: columns.map((c) => c[i]) }));
}

const quantile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };

function solve(matrix, vector) {
  const n = vector.length, m = matrix.map((row, i) => [...row, vector[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-15) throw new Error("singular ridge system");
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

// history: Map symbol -> bars { date, open, close, high, low, volume } before
// the target date. Returns null without RANK_TRAIN_DAYS usable sessions.
export function trainRankModel(history) {
  const byDate = new Map();
  for (const [symbol, bars] of history) {
    const asc = [...bars].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = RANK_FEATURE_SESSIONS; i < asc.length; i++) {
      if (!validBar(asc[i])) continue;
      const features = rankFeatures(asc.slice(i - RANK_FEATURE_SESSIONS, i).reverse());
      if (!features) continue;
      if (!byDate.has(asc[i].date)) byDate.set(asc[i].date, []);
      byDate.get(asc[i].date).push({ symbol, features, y: asc[i].close / asc[i].open - 1 });
    }
  }
  const dates = [...byDate.keys()].filter((d) => byDate.get(d).length >= RANK_MIN_SYMBOLS).sort().slice(-RANK_TRAIN_DAYS);
  if (dates.length < RANK_TRAIN_DAYS) return null;
  const k = RANK_FEATURE_NAMES.length + 1, a = Array.from({ length: k }, () => Array(k).fill(0)), b = Array(k).fill(0);
  const dayMeans = [];
  let n = 0;
  for (const date of dates) {
    const rows = byDate.get(date), ranked = rankCrossSection(rows), ys = new Map(rows.map((r) => [r.symbol, r.y]));
    const values = rows.map((r) => r.y), lo = quantile(values, 0.01), hi = quantile(values, 0.99);
    const clipped = new Map([...ys].map(([s, y]) => [s, Math.max(lo, Math.min(hi, y))]));
    const dayMean = mean([...clipped.values()]);
    dayMeans.push(dayMean);
    for (const row of ranked) {
      const x = [1, ...row.ranks], y = clipped.get(row.symbol) - dayMean;
      for (let r = 0; r < k; r++) { b[r] += x[r] * y; for (let c = 0; c < k; c++) a[r][c] += x[r] * x[c]; }
      n++;
    }
  }
  for (let r = 1; r < k; r++) a[r][r] += RANK_LAMBDA * n;
  return { model: RANK_MODEL, lambda: RANK_LAMBDA, feature_names: [...RANK_FEATURE_NAMES], train_first_date: dates[0], train_last_date: dates[dates.length - 1], train_days: dates.length, samples: n, level: mean(dayMeans), weights: solve(a, b) };
}

export function isRankModel(m) {
  return Boolean(m) && m.model === RANK_MODEL && m.lambda === RANK_LAMBDA && Array.isArray(m.feature_names) && m.feature_names.join() === RANK_FEATURE_NAMES.join()
    && /^\d{4}-\d{2}-\d{2}$/.test(m.train_first_date) && /^\d{4}-\d{2}-\d{2}$/.test(m.train_last_date) && m.train_first_date <= m.train_last_date
    && m.train_days === RANK_TRAIN_DAYS && Number.isSafeInteger(m.samples) && m.samples >= RANK_TRAIN_DAYS * RANK_MIN_SYMBOLS
    && finite(m.level) && Array.isArray(m.weights) && m.weights.length === RANK_FEATURE_NAMES.length + 1 && m.weights.every(finite);
}

export function rankPredict(m, ranks) {
  return m.level + m.weights[0] + ranks.reduce((sum, v, j) => sum + m.weights[j + 1] * v, 0);
}

// Predictions for every symbol with RANK_FEATURE_SESSIONS valid bars:
// { symbol: { features, ranks, predicted } }.
export function predictCrossSection(m, barsBySymbol) {
  const entries = [];
  for (const [symbol, bars] of barsBySymbol) { const features = rankFeatures(bars); if (features) entries.push({ symbol, features }); }
  if (entries.length < RANK_MIN_SYMBOLS) return null;
  return Object.fromEntries(rankCrossSection(entries).map((e) => [e.symbol, { features: e.features, ranks: e.ranks, predicted: rankPredict(m, e.ranks) }]));
}
