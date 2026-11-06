import { trainRankModel, predictCrossSection } from "./rank-model.js";

export const PERSONAL_MODEL = "rank_personal_residual_shrink_v1";

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const sampleSd = (values, m) => (values.length > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1)) : 0);

// n is always the full (untrimmed) residual count, so a short-history symbol
// is still shrunk toward zero the same way as before trimming was added.
//
// Winsorized: the top and bottom floor(n / 10) residuals are dropped before
// computing the mean/t-stat (same trim ratio as forecast-basis.js's
// shrunkSessionReturn), so a short run of extreme days -- e.g. one huge
// speculative spike in an otherwise ordinary stock -- doesn't by itself set
// the adjustment. On top of that, an extra volatility dampening factor
// compares the trimmed sample's dispersion to the full sample's: when the
// untrimmed residuals are far more volatile than the trimmed ones, the
// trimmed-out days were doing most of the explaining, so the signal that
// survives trimming is shrunk further rather than taken at its own t-stat's
// word. Both are symbol-specific, since a short recent price run (large
// residuals produced by the symbol's own history) is the exact case that
// should not translate into near-full confidence.
export function personalStats(residuals) {
  const n = residuals.length;
  const rawMean = mean(residuals);
  const rawSd = sampleSd(residuals, rawMean);
  const trim = Math.floor(n / 10);
  const trimmed = [...residuals].sort((a, b) => a - b).slice(trim, n - trim);
  const m = trimmed.length;
  const trimmedMean = mean(trimmed);
  const trimmedSd = sampleSd(trimmed, trimmedMean);
  const se = m > 0 ? trimmedSd / Math.sqrt(m) : 0;
  const t = se > 0 ? trimmedMean / se : 0;
  const rankConfidence = n / (n + 20) * (t * t / (1 + t * t));
  const volatilityDamping = rawSd > 0 ? Math.min(1, trimmedSd / rawSd) : 1;
  const confidence = rankConfidence * volatilityDamping;
  return { n, mean: trimmedMean, sd: trimmedSd, confidence, adjustment: trimmedMean * confidence };
}

// Reconstruct each historical prediction exclusively from bars before that day.
export function buildPersonalModel(observations, targetDate, log = () => {}) {
  const history = new Map();
  for (const b of observations) {
    if (!(b.date < targetDate)) continue;
    if (!history.has(b.symbol)) history.set(b.symbol, []);
    history.get(b.symbol).push(b);
  }
  for (const bars of history.values()) bars.sort((a, b) => a.date.localeCompare(b.date));
  const dates = [...new Set([...history.values()].flatMap(b => b.map(x => x.date)))].sort().slice(-20);
  if (dates.length !== 20) throw new Error("personal model requires 20 prior sessions");
  const residuals = {};
  for (const date of dates) {
    const before = new Map([...history].map(([s, b]) => [s, b.filter(x => x.date < date)]));
    const model = trainRankModel(before);
    if (!model || !(model.train_last_date < date)) throw new Error(`personal model training unavailable for ${date}`);
    const predicted = predictCrossSection(model, new Map([...before].map(([s, b]) => [s, b.slice(-20).reverse()])));
    if (!predicted) throw new Error(`personal model cross-section unavailable for ${date}`);
    let count = 0;
    for (const [symbol, p] of Object.entries(predicted)) {
      const bar = history.get(symbol).find(b => b.date === date);
      if (!(bar?.open > 0 && bar?.close > 0)) continue;
      (residuals[symbol] ||= []).push({ date, value: bar.close / bar.open - 1 - p.predicted });
      count++;
    }
    log(`종목별 보정 학습 ${date} · ${count}종목 · 공통 모델 학습 종료 ${model.train_last_date}`);
  }
  return { model: PERSONAL_MODEL, target_date: targetDate, dates, residuals };
}
