// Daily-retrained ridge regression for the expected session (open->close)
// return. Trained each morning on the prior TRAIN_DAYS sessions of every
// symbol; the prediction is calibrated by the fit itself, so no cap is applied.
// Walk-forward backtest 2026-09-01..10-28 (38 sessions, 913 KOSPI symbols):
// rank IC 0.031 (t 2.32) -> 0.053 (t 2.66), MAE 1.93% -> 1.91%, calibration
// slope 0.21 -> 0.71 versus the trimmed, shrunk 20-session mean capped at 1%.
export const RIDGE_MODEL = "ridge_6_features_60_sessions_v1";
export const FEATURE_SESSIONS = 20;
export const TRAIN_DAYS = 60;
export const MIN_SAMPLES_PER_DAY = 300;
export const RIDGE_LAMBDA = 0.5;
export const FEATURE_NAMES = Object.freeze(["trimmed_mean_20", "mean_5", "last_return", "last_gap", "momentum_20", "volatility_20"]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const pstdev = (values) => { const m = mean(values); return Math.sqrt(mean(values.map((v) => (v - m) ** 2))); };

// candles: exactly FEATURE_SESSIONS { open, close } bars, newest first.
export function ridgeFeatures(candles) {
  if (!Array.isArray(candles) || candles.length !== FEATURE_SESSIONS || !candles.every((c) => finite(c?.open) && c.open > 0 && finite(c?.close) && c.close > 0)) return null;
  const returns = candles.map((c) => c.close / c.open - 1);
  const trimmed = [...returns].sort((a, b) => a - b).slice(2, FEATURE_SESSIONS - 2);
  return [
    mean(trimmed),
    mean(returns.slice(0, 5)),
    returns[0],
    candles[0].open / candles[1].close - 1,
    candles[0].close / candles[FEATURE_SESSIONS - 1].open - 1,
    pstdev(returns),
  ];
}

// Lower and upper 1% order statistics, as used for winsorizing.
function bounds(values) {
  const sorted = [...values].sort((a, b) => a - b), k = Math.floor(sorted.length / 100);
  return [sorted[k], sorted[sorted.length - 1 - k]];
}
const clip = (value, [lo, hi]) => Math.max(lo, Math.min(hi, value));

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

// history: Map or object symbol -> candles { date, open, close } (any order,
// valid bars only, all before the target date). Returns null when fewer than
// TRAIN_DAYS dates have MIN_SAMPLES_PER_DAY samples.
export function trainRidgeModel(history) {
  const byDate = new Map();
  for (const candles of history instanceof Map ? history.values() : Object.values(history)) {
    const asc = [...candles].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = FEATURE_SESSIONS; i < asc.length; i++) {
      const features = ridgeFeatures(asc.slice(i - FEATURE_SESSIONS, i).reverse());
      if (!features) continue;
      if (!byDate.has(asc[i].date)) byDate.set(asc[i].date, []);
      byDate.get(asc[i].date).push({ features, y: asc[i].close / asc[i].open - 1 });
    }
  }
  const dates = [...byDate.keys()].filter((d) => byDate.get(d).length >= MIN_SAMPLES_PER_DAY).sort().slice(-TRAIN_DAYS);
  if (dates.length < TRAIN_DAYS) return null;
  const samples = dates.flatMap((d) => byDate.get(d));
  const k = FEATURE_NAMES.length;
  const lower = [], upper = [], means = [], sds = [];
  const columns = Array.from({ length: k }, (_, j) => samples.map((s) => s.features[j]));
  for (let j = 0; j < k; j++) {
    const b = bounds(columns[j]); lower.push(b[0]); upper.push(b[1]);
    const clipped = columns[j].map((v) => clip(v, b));
    means.push(mean(clipped)); sds.push(pstdev(clipped) || 1);
  }
  const yBounds = bounds(samples.map((s) => s.y));
  const z = samples.map((s) => [1, ...s.features.map((v, j) => (clip(v, [lower[j], upper[j]]) - means[j]) / sds[j])]);
  const y = samples.map((s) => clip(s.y, yBounds));
  const n = samples.length;
  const a = Array.from({ length: k + 1 }, (_, r) => Array.from({ length: k + 1 }, (_, c) => z.reduce((sum, row) => sum + row[r] * row[c], 0) + (r === c && r > 0 ? RIDGE_LAMBDA * n : 0)));
  const b = Array.from({ length: k + 1 }, (_, r) => z.reduce((sum, row, i) => sum + row[r] * y[i], 0));
  const weights = solve(a, b);
  return { model: RIDGE_MODEL, lambda: RIDGE_LAMBDA, feature_names: [...FEATURE_NAMES], train_first_date: dates[0], train_last_date: dates[dates.length - 1], train_days: dates.length, samples: n, lower, upper, means, sds, weights };
}

export function isRidgeModel(m) {
  const arr = (v, len) => Array.isArray(v) && v.length === len && v.every(finite);
  const k = FEATURE_NAMES.length;
  return Boolean(m) && m.model === RIDGE_MODEL && m.lambda === RIDGE_LAMBDA && Array.isArray(m.feature_names) && m.feature_names.join() === FEATURE_NAMES.join()
    && /^\d{4}-\d{2}-\d{2}$/.test(m.train_first_date) && /^\d{4}-\d{2}-\d{2}$/.test(m.train_last_date) && m.train_first_date <= m.train_last_date
    && m.train_days === TRAIN_DAYS && Number.isSafeInteger(m.samples) && m.samples >= TRAIN_DAYS * MIN_SAMPLES_PER_DAY
    && arr(m.lower, k) && arr(m.upper, k) && arr(m.means, k) && arr(m.sds, k) && arr(m.weights, k + 1)
    && m.lower.every((lo, j) => lo <= m.upper[j]) && m.sds.every((s) => s > 0);
}

// Returns the clipped features and the predicted session return.
export function ridgePredict(m, features) {
  const clipped = features.map((v, j) => clip(v, [m.lower[j], m.upper[j]]));
  const predicted = m.weights[0] + clipped.reduce((sum, v, j) => sum + m.weights[j + 1] * ((v - m.means[j]) / m.sds[j]), 0);
  return { clipped, predicted };
}
