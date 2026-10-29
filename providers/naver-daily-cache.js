import { readFile } from "node:fs/promises";
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

export async function loadNaverDailyHistory({ targetDate, now = () => new Date(), path = null }) {
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
    // stored bars across the same cross-section; any difference invalidates it.
    let rank_forecast = null;
    if (record.rank_forecast !== undefined && record.rank_forecast !== null) {
      const rf = record.rank_forecast, preds = rf?.predictions;
      if (!isRankModel(rf?.model) || !(rf.model.train_last_date < targetDate) || !preds || typeof preds !== "object" || !return_history) throw new Error("invalid rank forecast");
      const symbols = Object.keys(preds);
      if (symbols.some((s) => !return_history[s] || return_history[s].length !== RANK_FEATURE_SESSIONS || return_history[s][0].volume === undefined)) throw new Error("invalid rank forecast");
      const again = predictCrossSection(rf.model, new Map(symbols.map((s) => [s, return_history[s]])));
      const same = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
      if (!again || Object.keys(again).length !== symbols.length || symbols.some((s) => !again[s] || !same(again[s].predicted, preds[s]?.predicted) || !Array.isArray(preds[s].ranks) || !again[s].ranks.every((v, j) => same(v, preds[s].ranks[j])) || !Array.isArray(preds[s].features) || !again[s].features.every((v, j) => same(v, preds[s].features[j])))) throw new Error("rank forecast does not reproduce");
      rank_forecast = { model: rf.model, predictions: preds };
    }
    const comparison_conflicts = sessions.reduce((n, s) => n + s.rows.filter(r => r.comparison === "conflict").length, 0);
    return { ok: true, source: "naver-daily", source_basis: "naver-daily", security_type: "unknown", sessions, return_history, forecast_model, rank_forecast, symbols: record.symbols, valid_symbols: valid, retrieved_at: record.retrieved_at, excluded_count: record.symbols.length - valid.length, no_trade_symbols, no_trade_count: no_trade_symbols.length, comparison_conflicts, partial: valid.length + no_trade_symbols.length !== record.symbols.length, robots_url: typeof record.robots_url === "string" ? record.robots_url : "https://api.stock.naver.com/robots.txt", robots_checked_at: typeof record.robots_checked_at === "string" ? record.robots_checked_at : null, robots_status: Number.isInteger(record.robots_status) ? record.robots_status : null, universe_source: typeof record.universe_source === "string" ? record.universe_source : null, universe_stale: typeof record.universe_stale === "boolean" ? record.universe_stale : null };
  } catch (error) { return { ok: false, reason: `Naver daily history unavailable: ${error.message}` }; }
}
