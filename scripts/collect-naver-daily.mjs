import { mkdir, open, readFile, writeFile, link, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { collectNaverUniverse } from "../providers/naver-crawl-provider.js";
import { collectNaverDailyRows } from "../providers/naver-daily-rows.js";
import { dailyHistoryPath, loadNaverDailyHistory, priorTradingDates } from "../providers/naver-daily-cache.js";
import { repoPath } from "../providers/repo-paths.js";
import { kstDate } from "./market-calendar.mjs";
import { RETURN_HISTORY_SESSIONS } from "../providers/forecast-basis.js";
import { trainRidgeModel } from "../providers/ridge-model.js";
import { RANK_FEATURE_SESSIONS, predictCrossSection, trainRankModel } from "../providers/rank-model.js";

export async function collectDaily({ now = () => new Date(), universeFetcher = collectNaverUniverse, collector = collectNaverDailyRows, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = now(), targetDate = kstDate(started), cutoff = Date.parse(`${targetDate}T08:00:00+09:00`);
  if (started.getTime() >= cutoff) throw new Error("Daily collection must start and finish before 08:00 KST");
  const dates = await priorTradingDates(targetDate);
  const path = dailyHistoryPath(targetDate);
  await mkdir(repoPath("data/daily-history"), { recursive: true });
  const lockPath = `${path}.lock`, tempPath = `${path}.${randomUUID()}.tmp`;
  let lock;
  try { lock = await open(lockPath, "wx"); } catch (error) { if (error.code === "EEXIST") throw new Error(`Collection lock exists: ${lockPath}; inspect before manual recovery`); throw error; }
  try {
  let original = null;
  try { original = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const existing = original === null ? null : await loadNaverDailyHistory({ targetDate, now, path });
  if (existing && !existing.ok) throw new Error(`Existing cache is invalid and was preserved: ${existing.reason}`);
  if (existing && !existing.partial) return { status: "preserved", path, excluded: 0 };
  const universe = await universeFetcher({ deadline: cutoff });
  if (!universe.ok) throw new Error(`universe unavailable: ${universe.reason}`);
  const symbols = universe.symbols.map(s => s.symbol);
  if (existing && (symbols.length !== existing.symbols.length || symbols.some(s => !existing.symbols.includes(s)))) throw new Error("Universe changed; existing partial cache preserved");
  await sleep(500); // Separate the final universe request from the first daily request.
  if (now().getTime() >= cutoff) throw new Error("Daily collection deadline reached after universe lookup");
  const result = await collector({ symbols, targetDate, deadline: cutoff });
  if (!["ready", "partial"].includes(result.status) || now().getTime() >= cutoff || result.requested !== symbols.length) throw new Error(`daily collection incomplete: ${result.reason || result.status}`);
  const sessions = dates.map(date => ({ date, rows: result.observations.filter(r => r.date === date) }));
  const maps = sessions.map(s => new Set(s.rows.map(r => r.symbol)));
  const complete = symbols.filter(s => maps.every(m => m.has(s)));
  if (!complete.length) throw new Error("No symbol has complete prior trading sessions");
  if (existing && (complete.length <= existing.valid_symbols.length || existing.valid_symbols.some(s => !complete.includes(s)))) return { status: "preserved", path, excluded: existing.excluded_count, reason: "no_coverage_improvement" };
  if (existing) {
    for (let i = 0; i < sessions.length; i++) {
      const previous = new Map(existing.sessions[i].rows.map(row => [row.symbol, row]));
      for (const row of sessions[i].rows) if (previous.has(row.symbol) && JSON.stringify(row) !== JSON.stringify(previous.get(row.symbol))) throw new Error("Previously valid history changed; existing partial cache preserved");
    }
  }
  // Up to RETURN_HISTORY_SESSIONS valid prior candles per complete symbol,
  // newest first, as [date, open, close, high, low, volume].
  const returnHistory = Object.fromEntries(complete.map(symbol => [symbol, result.observations.filter(r => r.symbol === symbol && r.date < targetDate)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, RETURN_HISTORY_SESSIONS).map(r => [r.date, r.open, r.close, r.high, r.low, r.volume])]));
  // Retrained every morning on all valid prior candles; null (the 20-session
  // model is used instead) when there is not enough history.
  const byCandles = new Map();
  for (const r of result.observations) if (r.date < targetDate) { if (!byCandles.has(r.symbol)) byCandles.set(r.symbol, []); byCandles.get(r.symbol).push({ date: r.date, open: r.open, close: r.close, high: r.high, low: r.low, volume: r.volume }); }
  let forecastModel = null;
  try { forecastModel = trainRidgeModel(byCandles); } catch { forecastModel = null; }
  // Cross-sectional rank model: trained and applied here, because ranks need
  // every symbol's features of the same morning. null falls back to the above.
  let rankForecast = null;
  try {
    const rankModel = trainRankModel(byCandles);
    const bars = new Map(Object.entries(returnHistory).filter(([, c]) => c.length === RANK_FEATURE_SESSIONS).map(([s, c]) => [s, c.map(([date, open, close, high, low, volume]) => ({ date, open, close, high, low, volume }))]));
    const predictions = rankModel ? predictCrossSection(rankModel, bars) : null;
    rankForecast = rankModel && predictions ? { model: rankModel, predictions } : null;
  } catch { rankForecast = null; }
  const record = { schema_version: 1, source: "naver-daily", source_basis: "naver-daily", security_type: "unknown", target_date: targetDate, started_at: started.toISOString(), retrieved_at: now().toISOString(), license_status: "unconfirmed", market_venue: "unconfirmed", adjustment: "unconfirmed", symbols, sessions, return_history: returnHistory, forecast_model: forecastModel, rank_forecast: rankForecast, rejected: result.rejected, warnings: result.warnings || [], requested: result.requested, elapsed_ms: result.elapsed_ms, durations_ms: result.durations_ms, robots_url: result.robots_url ?? null, robots_status: result.robots_status ?? null, robots_checked_at: result.robots_checked_at ?? null, universe_source: universe.universeSource ?? null, universe_as_of: universe.universeAsOf ?? null, universe_stale: Boolean(universe.universeStale), coverage_status: complete.length === symbols.length ? "complete" : "partial", status: complete.length === symbols.length ? "ready" : "partial", notice: "Unofficial Naver endpoint; market venue, adjustment, publication time and redistribution rights unconfirmed. Daily OHLC can differ from regular-market quotes; comparison conflicts are warnings, not a basis to modify prices." };
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const candidate = await loadNaverDailyHistory({ targetDate, now, path: tempPath });
  if (!candidate.ok) throw new Error(`Candidate cache invalid: ${candidate.reason}`);
  if (original === null) await link(tempPath, path);
  else {
    if (await readFile(path, "utf8") !== original) throw new Error("Cache changed during collection; replacement aborted");
    await rename(tempPath, path);
  }
  return { status: record.status, path, excluded: symbols.length - complete.length, requested: result.requested, elapsed_ms: result.elapsed_ms };
  } finally {
    await unlink(tempPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  collectDaily().then(result => { console.log(JSON.stringify(result)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
