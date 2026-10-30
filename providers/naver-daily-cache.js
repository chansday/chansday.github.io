import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyMarketDate, isValidDate, loadMarketCalendar } from "../scripts/market-calendar.mjs";
import { isKoreanSymbol } from "./korean-symbol.js";
import { repoPath } from "./repo-paths.js";
import { RETURN_HISTORY_SESSIONS } from "./forecast-basis.js";
import { isRidgeModel } from "./ridge-model.js";
import { RANK_FEATURE_SESSIONS, isRankModel, predictCrossSection } from "./rank-model.js";

export const dailyHistoryPath = (targetDate) => repoPath(`data/daily-history/${targetDate}.json`);

export async function priorTradingDates(targetDate) {
  const calendar = await loadMarketCalendar();
  if (classifyMarketDate(targetDate, calendar).status !== "run") throw new Error("Target is not a covered trading day");
  const result = [];
  for (let days = 1; days <= 30 && result.length < 3; days++) {
    const date = new Date(`${targetDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - days);
    const value = date.toISOString().slice(0, 10), state = classifyMarketDate(value, calendar);
    if (state.status === "error") throw new Error(state.message);
    if (state.status === "run") result.push(value);
  }
  if (result.length !== 3) throw new Error("Insufficient calendar coverage");
  return result;
}

// The day's rank forecast when it was trained and reproduces; otherwise the
// most recent successfully trained rank model (from an earlier daily-history
// cache whose own rank_forecast reproduced) applied to this day's 20-session
// bars and cross-section. No other model substitutes for it: without a previous
// success the status is "unavailable" and expected closes stay null.
// historyDir: where earlier caches are looked up (default data/daily-history).
export async function findPreviousRankModel({ targetDate, now = () => new Date(), historyDir = null }) {
  const dir = historyDir || repoPath("data/daily-history");
  let names = [];
  try { names = await readdir(dir); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const dates = names.map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter((date) => date && date < targetDate).sort().reverse();
  for (const date of dates) {
    const previous = await loadNaverDailyHistory({ targetDate: date, now, path: join(dir, `${date}.json`), reuseRankModel: false });
    const model = previous.ok ? previous.rank_forecast?.model : null;
    if (model && isRankModel(model) && model.train_last_date < targetDate) return { model, trained_for: date };
  }
  return null;
}

export async function reuseRankForecast({ targetDate, returnHistory, now = () => new Date(), historyDir = null, failure = null }) {
  const why = failure || "rank_forecast missing";
  const previous = await findPreviousRankModel({ targetDate, now, historyDir });
  if (!previous) return { rank_forecast: null, status: { status: "unavailable", model: null, train_last_date: null, reused_from: null, reason: `${why}; no earlier successfully trained rank model` } };
  const bars = new Map(Object.entries(returnHistory || {}).filter(([, c]) => Array.isArray(c) && c.length === RANK_FEATURE_SESSIONS && c.every((b) => b?.volume !== undefined)));
  const model = { ...previous.model, reused_from: previous.trained_for };
  const predictions = bars.size ? predictCrossSection(model, bars) : null;
  if (!predictions) return { rank_forecast: null, status: { status: "unavailable", model: model.model, train_last_date: model.train_last_date, reused_from: previous.trained_for, reason: `${why}; fewer than the minimum symbols have ${RANK_FEATURE_SESSIONS} sessions of daily bars` } };
  return { rank_forecast: { model, predictions }, status: { status: "reused", model: model.model, train_last_date: model.train_last_date, reused_from: previous.trained_for, reason: why } };
}

export async function loadNaverDailyHistory({ targetDate, now = () => new Date(), path = null, reuseRankModel = true, historyDir = null }) {
  try {
    if (!isValidDate(targetDate)) throw new Error("invalid target date");
    const expected = await priorTradingDates(targetDate);
    const record = JSON.parse(await readFile(path ? repoPath(path) : dailyHistoryPath(targetDate), "utf8"));
    const start = Date.parse(record.started_at), end = Date.parse(record.retrieved_at), cutoff = Date.parse(`${targetDate}T08:00:00+09:00`);
    // A morning cache starts on the target date; an evening cache starts after
    // 18:00 KST (after-hours close) of the previous trading day.
    if (![undefined, "morning", "evening"].includes(record.collection)) throw new Error("invalid collection kind");
    const earliestStart = record.collection === "evening" ? Date.parse(`${expected[0]}T18:00:00+09:00`) : Date.parse(`${targetDate}T00:00:00+09:00`);
    const current = now().getTime();
    if (record.schema_version !== 1 || record.source !== "naver-daily" || record.target_date !== targetDate || record.license_status !== "unconfirmed" || ![start, end, current].every(Number.isFinite) || start > end || end >= cutoff || end > current || start < earliestStart) throw new Error("history identity or collection time mismatch");
    if (!Array.isArray(record.sessions) || record.sessions.length !== 3 || record.sessions.some((s, i) => s.date !== expected[i] || !Array.isArray(s.rows))) throw new Error("history session coverage mismatch");
    if (!Array.isArray(record.symbols) || new Set(record.symbols).size !== record.symbols.length || record.symbols.some(s => !isKoreanSymbol(s))) throw new Error("invalid universe");
    const universe = new Set(record.symbols);
    const maps = record.sessions.map(s => {
      const map = new Map();
      for (const r of s.rows) {
        if (r.date !== s.date || !isKoreanSymbol(r.symbol) || !universe.has(r.symbol) || map.has(r.symbol) || (r.comparison !== undefined && !["consistent", "conflict", "unverified"].includes(r.comparison)) || ![r.open, r.high, r.low, r.close, r.volume].every(n => Number.isSafeInteger(n) && n > 0) || r.high < Math.max(r.open, r.close) || r.low > Math.min(r.open, r.close)) throw new Error("invalid history row");
        map.set(r.symbol, r);
      }
      return map;
    });
    const valid = record.symbols.filter(symbol => maps.every(map => map.has(symbol)));
    if (!valid.length) throw new Error("no symbol has three valid sessions");
    const allowed = new Set(valid);
    // A symbol is no_trade only when every session it lacks was rejected
    // because the source reported volume 0; any other gap is still missing.
    const zero = new Map();
    for (const r of Array.isArray(record.rejected) ? record.rejected : []) {
      if (r?.reason !== "zero_volume" || !universe.has(r.symbol) || !expected.includes(r.date)) continue;
      if (!zero.has(r.symbol)) zero.set(r.symbol, new Set());
      zero.get(r.symbol).add(r.date);
    }
    const no_trade_symbols = record.symbols.filter(symbol => !allowed.has(symbol) && zero.has(symbol) && expected.every((date, i) => maps[i].has(symbol) || zero.get(symbol).has(date)))
      .map(symbol => ({ symbol, dates: expected.filter(date => zero.get(symbol).has(date)) }));
    const sessions = record.sessions.map(s => ({ ...s, url: "https://api.stock.naver.com/chart/domestic/item/", rows: s.rows.filter(r => allowed.has(r.symbol)) }));
    // Optional (caches collected before 2026-10-30 lack it): per-symbol prior
    // [date, open, close] candles, newest first, whose first three entries are
    // the three sessions above. Any inconsistency invalidates the whole cache.
    let return_history = null;
    if (record.return_history !== undefined) {
      if (!record.return_history || typeof record.return_history !== "object" || Array.isArray(record.return_history)) throw new Error("invalid return history");
      return_history = {};
      // Entries are [date, open, close] (older caches) or [date, open, close, high, low, volume].
      const width = Object.values(record.return_history)[0]?.[0]?.length;
      if (Object.keys(record.return_history).length && ![3, 6].includes(width)) throw new Error("invalid return history");
      for (const [symbol, candles] of Object.entries(record.return_history)) {
        if (!universe.has(symbol) || !Array.isArray(candles) || candles.length < 3 || candles.length > RETURN_HISTORY_SESSIONS) throw new Error("invalid return history");
        candles.forEach((c, k) => {
          if (!Array.isArray(c) || c.length !== width || !isValidDate(c[0]) || !(c[0] < targetDate) || (k && !(c[0] < candles[k - 1][0])) || !c.slice(1).every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid return history");
          if (width === 6 && (c[3] < Math.max(c[1], c[2]) || c[4] > Math.min(c[1], c[2]))) throw new Error("invalid return history");
          if (k < 3) { const row = maps[k].get(symbol); if (c[0] !== expected[k] || !row || row.open !== c[1] || row.close !== c[2] || (width === 6 && (row.high !== c[3] || row.low !== c[4] || row.volume !== c[5]))) throw new Error("return history disagrees with sessions"); }
        });
        if (allowed.has(symbol)) return_history[symbol] = candles.map(([date, open, close, high, low, volume]) => width === 6 ? { date, open, close, high, low, volume } : { date, open, close });
      }
    }
    // Optional trained model; a malformed one invalidates the cache, null means
    // training had too little history.
    if (record.forecast_model !== undefined && record.forecast_model !== null && (!isRidgeModel(record.forecast_model) || !(record.forecast_model.train_last_date < targetDate))) throw new Error("invalid forecast model");
    const forecast_model = record.forecast_model ?? null;
    // Optional rank forecast: every stored prediction is recomputed from the
    // stored bars across the same cross-section. A forecast that is malformed or
    // does not reproduce is discarded (the validated bars stay usable) and,
    // like a missing one, replaced by the most recent successful rank model.
    let rank_forecast = null, rankFailure = null;
    if (record.rank_forecast !== undefined && record.rank_forecast !== null) {
      const rf = record.rank_forecast, preds = rf?.predictions;
      const same = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
      const symbols = preds && typeof preds === "object" ? Object.keys(preds) : [];
      if (!isRankModel(rf?.model) || !(rf.model.train_last_date < targetDate) || !preds || typeof preds !== "object" || !return_history) rankFailure = "invalid rank forecast";
      else if (symbols.some((s) => !return_history[s] || return_history[s].length !== RANK_FEATURE_SESSIONS || return_history[s][0].volume === undefined)) rankFailure = "invalid rank forecast";
      else {
        const again = predictCrossSection(rf.model, new Map(symbols.map((s) => [s, return_history[s]])));
        if (!again || Object.keys(again).length !== symbols.length || symbols.some((s) => !again[s] || !same(again[s].predicted, preds[s]?.predicted) || !Array.isArray(preds[s].ranks) || !again[s].ranks.every((v, j) => same(v, preds[s].ranks[j])) || !Array.isArray(preds[s].features) || !again[s].features.every((v, j) => same(v, preds[s].features[j])))) rankFailure = "rank forecast does not reproduce";
        else rank_forecast = { model: rf.model, predictions: preds };
      }
    } else rankFailure = record.rank_forecast === null ? "rank model training failed (rank_forecast null)" : "rank_forecast missing";
    let rank_forecast_status = rank_forecast
      ? { status: "trained", model: rank_forecast.model.model, train_last_date: rank_forecast.model.train_last_date, reused_from: null, reason: null }
      : { status: "unavailable", model: null, train_last_date: null, reused_from: null, reason: rankFailure };
    if (!rank_forecast && reuseRankModel) ({ rank_forecast, status: rank_forecast_status } = await reuseRankForecast({ targetDate, returnHistory: return_history, now, historyDir, failure: rankFailure }));
    const comparison_conflicts = sessions.reduce((n, s) => n + s.rows.filter(r => r.comparison === "conflict").length, 0);
    return { ok: true, source: "naver-daily", source_basis: "naver-daily", security_type: "unknown", sessions, return_history, forecast_model, rank_forecast, rank_forecast_status, symbols: record.symbols, valid_symbols: valid, retrieved_at: record.retrieved_at, excluded_count: record.symbols.length - valid.length, no_trade_symbols, no_trade_count: no_trade_symbols.length, comparison_conflicts, partial: valid.length + no_trade_symbols.length !== record.symbols.length, robots_url: typeof record.robots_url === "string" ? record.robots_url : "https://api.stock.naver.com/robots.txt", robots_checked_at: typeof record.robots_checked_at === "string" ? record.robots_checked_at : null, robots_status: Number.isInteger(record.robots_status) ? record.robots_status : null, universe_source: typeof record.universe_source === "string" ? record.universe_source : null, universe_stale: typeof record.universe_stale === "boolean" ? record.universe_stale : null };
  } catch (error) { return { ok: false, reason: `Naver daily history unavailable: ${error.message}` }; }
}
