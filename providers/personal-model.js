import { trainRankModel, predictCrossSection } from "./rank-model.js";

export const PERSONAL_MODEL = "rank_personal_residual_shrink_v1";

export function personalStats(residuals) {
  const n = residuals.length;
  const mean = n ? residuals.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(residuals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const confidence = n / (n + 20) * (t * t / (1 + t * t));
  return { n, mean, sd, confidence, adjustment: mean * confidence };
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
