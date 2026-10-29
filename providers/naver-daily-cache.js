import { readFile } from "node:fs/promises";
import { classifyMarketDate, isValidDate, loadMarketCalendar } from "../scripts/market-calendar.mjs";
import { isKoreanSymbol } from "./korean-symbol.js";
import { repoPath } from "./repo-paths.js";

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
    const current = now().getTime();
    if (record.schema_version !== 1 || record.source !== "naver-daily" || record.target_date !== targetDate || record.license_status !== "unconfirmed" || ![start, end, current].every(Number.isFinite) || start > end || end >= cutoff || end > current || start < Date.parse(`${targetDate}T00:00:00+09:00`)) throw new Error("history identity or collection time mismatch");
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
    const comparison_conflicts = sessions.reduce((n, s) => n + s.rows.filter(r => r.comparison === "conflict").length, 0);
    return { ok: true, source: "naver-daily", source_basis: "naver-daily", security_type: "unknown", sessions, symbols: record.symbols, valid_symbols: valid, retrieved_at: record.retrieved_at, excluded_count: record.symbols.length - valid.length, no_trade_symbols, no_trade_count: no_trade_symbols.length, comparison_conflicts, partial: valid.length + no_trade_symbols.length !== record.symbols.length, robots_url: typeof record.robots_url === "string" ? record.robots_url : "https://api.stock.naver.com/robots.txt", robots_checked_at: typeof record.robots_checked_at === "string" ? record.robots_checked_at : null, robots_status: Number.isInteger(record.robots_status) ? record.robots_status : null, universe_source: typeof record.universe_source === "string" ? record.universe_source : null, universe_stale: typeof record.universe_stale === "boolean" ? record.universe_stale : null };
  } catch (error) { return { ok: false, reason: `Naver daily history unavailable: ${error.message}` }; }
}
