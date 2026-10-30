// Test fixture only: a structurally valid rank model whose prediction is the
// constant `level` (all weights 0), plus 20-session bars whose newest three
// match the given sessions. Lets retrospective/pipeline tests exercise the rank
// path (the only expected-close model) without training on 300 symbols.
import { RANK_FEATURE_NAMES, RANK_FEATURE_SESSIONS, RANK_LAMBDA, RANK_MIN_SYMBOLS, RANK_MODEL, RANK_TRAIN_DAYS } from "../../providers/rank-model.js";

export function constantRankModel({ level = 0.01, trainLastDate = "2026-10-21", trainFirstDate = "2026-07-01" } = {}) {
  return { model: RANK_MODEL, lambda: RANK_LAMBDA, feature_names: [...RANK_FEATURE_NAMES], train_first_date: trainFirstDate, train_last_date: trainLastDate, train_days: RANK_TRAIN_DAYS, samples: RANK_TRAIN_DAYS * RANK_MIN_SYMBOLS, level, weights: Array(RANK_FEATURE_NAMES.length + 1).fill(0) };
}

// sessions: newest first, rows with { symbol, open, close }. Older bars repeat
// the oldest session's prices on earlier calendar days.
export function rankHistoryFor(sessions, symbols, options = {}) {
  const model = constantRankModel(options);
  const return_history = {}, predictions = {};
  for (const symbol of symbols) {
    const recent = sessions.map((s) => { const r = s.rows.find((row) => row.symbol === symbol); return { date: s.date, open: r.open, close: r.close, high: r.high ?? Math.max(r.open, r.close), low: r.low ?? Math.min(r.open, r.close), volume: r.volume ?? 10 }; });
    const oldest = recent[recent.length - 1];
    const older = Array.from({ length: RANK_FEATURE_SESSIONS - recent.length }, (_, k) => ({ ...oldest, date: new Date(Date.parse(`${oldest.date}T00:00:00Z`) - (k + 1) * 86400e3).toISOString().slice(0, 10) }));
    return_history[symbol] = [...recent, ...older];
    predictions[symbol] = { features: Array(RANK_FEATURE_NAMES.length).fill(0), ranks: Array(RANK_FEATURE_NAMES.length).fill(0), predicted: model.level + model.weights[0] };
  }
  return { return_history, rank_forecast: { model, predictions } };
}
