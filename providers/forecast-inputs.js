// Builds the expected-close inputs for one target date from daily bars that
// all precede it: per-symbol last RETURN_HISTORY_SESSIONS bars, the 6-feature
// ridge model and the cross-sectional rank forecast. Shared by the 06:10 daily
// collector and close catch-up so every path uses the same engine.
import { RETURN_HISTORY_SESSIONS } from "./forecast-basis.js";
import { trainRidgeModel } from "./ridge-model.js";
import { RANK_FEATURE_SESSIONS, predictCrossSection, trainRankModel } from "./rank-model.js";

// observations: [{ symbol, date, open, high, low, close, volume }]; symbols:
// the symbols complete in the three prior sessions.
export function buildForecastInputs({ observations, targetDate, symbols }) {
  const bySymbol = new Map();
  for (const r of observations) {
    if (!(r.date < targetDate)) continue;
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push({ date: r.date, open: r.open, close: r.close, high: r.high, low: r.low, volume: r.volume });
  }
  const returnHistory = Object.fromEntries(symbols.map((symbol) => [symbol, [...(bySymbol.get(symbol) || [])].sort((a, b) => b.date.localeCompare(a.date)).slice(0, RETURN_HISTORY_SESSIONS)]));
  let forecastModel = null;
  try { forecastModel = trainRidgeModel(bySymbol); } catch { forecastModel = null; }
  // Ranks need every symbol's features of the same morning, so the rank model
  // is trained and applied here; null falls back to the ridge model.
  let rankForecast = null;
  try {
    const model = trainRankModel(bySymbol);
    const bars = new Map(Object.entries(returnHistory).filter(([, c]) => c.length === RANK_FEATURE_SESSIONS));
    const predictions = model ? predictCrossSection(model, bars) : null;
    rankForecast = model && predictions ? { model, predictions } : null;
  } catch { rankForecast = null; }
  return { returnHistory, forecastModel, rankForecast };
}
