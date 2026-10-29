import { appendFile, mkdir, open, readFile, writeFile, link, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { collectNaverUniverse } from "../providers/naver-crawl-provider.js";
import { collectNaverDailyRows } from "../providers/naver-daily-rows.js";
import { dailyHistoryPath, loadNaverDailyHistory, priorTradingDates } from "../providers/naver-daily-cache.js";
import { repoPath } from "../providers/repo-paths.js";
import { classifyMarketDate, kstDate, loadMarketCalendar } from "./market-calendar.mjs";
import { buildForecastInputs } from "../providers/forecast-inputs.js";

// The first trading day after `date`.
export async function nextTradingDate(date) {
  const calendar = await loadMarketCalendar();
  for (let days = 1; days <= 30; days++) {
    const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
    const value = d.toISOString().slice(0, 10), state = classifyMarketDate(value, calendar);
    if (state.status === "error") throw new Error(state.message);
    if (state.status === "run") return value;
  }
  throw new Error("No trading day within 30 days");
}

export const EVENING_START = "18:00";

// evening: run after the close (and after-hours trading, which ends 18:00 KST)
// of a trading day D0, for the next trading day; history, models and the rank
// forecast are then ready before the next morning. The morning run (default)
// verifies an evening cache: unchanged bars keep it, changed bars replace it.
export async function collectDaily({ now = () => new Date(), universeFetcher = collectNaverUniverse, collector = collectNaverDailyRows, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), evening = false } = {}) {
  const started = now(), today = kstDate(started);
  let targetDate = today;
  // GitHub cron can start hours late: an evening run that starts after
  // midnight and before 08:00 KST becomes today's morning collection, and one
  // between 08:00 and 18:00 has nothing to do.
  if (evening && started.getTime() < Date.parse(`${today}T08:00:00+09:00`)) evening = false;
  else if (evening && started.getTime() < Date.parse(`${today}T${EVENING_START}:00+09:00`)) return { status: "skipped", reason: `evening collection starts after ${EVENING_START} KST`, targetDate: null };
  if (evening) {
    if (classifyMarketDate(today, await loadMarketCalendar()).status !== "run") throw new Error("Evening collection runs only after a trading day");
    targetDate = await nextTradingDate(today);
  }
  const cutoff = Date.parse(`${targetDate}T08:00:00+09:00`);
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
  const existingRecord = original === null ? null : JSON.parse(original);
  // A morning run re-checks a cache collected the evening before.
  const verifyEvening = Boolean(!evening && existing && existingRecord?.collection === "evening");
  if (existing && !existing.partial && !verifyEvening) return { status: "preserved", path, targetDate, excluded: 0 };
  const universe = await universeFetcher({ deadline: cutoff });
  if (!universe.ok) throw new Error(`universe unavailable: ${universe.reason}`);
  const symbols = universe.symbols.map(s => s.symbol);
  if (existing && !verifyEvening && (symbols.length !== existing.symbols.length || symbols.some(s => !existing.symbols.includes(s)))) throw new Error("Universe changed; existing partial cache preserved");
  await sleep(500); // Separate the final universe request from the first daily request.
  if (now().getTime() >= cutoff) throw new Error("Daily collection deadline reached after universe lookup");
  const result = await collector({ symbols, targetDate, deadline: cutoff });
  if (!["ready", "partial"].includes(result.status) || now().getTime() >= cutoff || result.requested !== symbols.length) throw new Error(`daily collection incomplete: ${result.reason || result.status}`);
  const sessions = dates.map(date => ({ date, rows: result.observations.filter(r => r.date === date) }));
  const maps = sessions.map(s => new Set(s.rows.map(r => r.symbol)));
  const complete = symbols.filter(s => maps.every(m => m.has(s)));
  if (!complete.length) throw new Error("No symbol has complete prior trading sessions");
  if (verifyEvening) {
    const same = JSON.stringify(existingRecord.symbols) === JSON.stringify(symbols) && existingRecord.sessions.every((s, i) => JSON.stringify(s.rows) === JSON.stringify(sessions[i].rows));
    if (same) return { status: "verified", path, targetDate, excluded: existing.excluded_count };
  }
  if (existing && !verifyEvening && (complete.length <= existing.valid_symbols.length || existing.valid_symbols.some(s => !complete.includes(s)))) return { status: "preserved", path, targetDate, excluded: existing.excluded_count, reason: "no_coverage_improvement" };
  if (existing && !verifyEvening) {
    for (let i = 0; i < sessions.length; i++) {
      const previous = new Map(existing.sessions[i].rows.map(row => [row.symbol, row]));
      for (const row of sessions[i].rows) if (previous.has(row.symbol) && JSON.stringify(row) !== JSON.stringify(previous.get(row.symbol))) throw new Error("Previously valid history changed; existing partial cache preserved");
    }
  }
  // Same engine inputs as close catch-up: last 20 bars per complete symbol
  // (stored as [date, open, close, high, low, volume]), ridge model, rank forecast.
  const inputs = buildForecastInputs({ observations: result.observations, targetDate, symbols: complete });
  const returnHistory = Object.fromEntries(Object.entries(inputs.returnHistory).map(([symbol, bars]) => [symbol, bars.map(b => [b.date, b.open, b.close, b.high, b.low, b.volume])]));
  const trainedAt = now().toISOString();
  const forecastModel = inputs.forecastModel ? { ...inputs.forecastModel, trained_at: trainedAt } : null;
  const rankForecast = inputs.rankForecast ? { ...inputs.rankForecast, model: { ...inputs.rankForecast.model, trained_at: trainedAt } } : null;
  const record = { schema_version: 1, collection: evening ? "evening" : "morning", ...(verifyEvening ? { replaced_evening_collection: { retrieved_at: existingRecord.retrieved_at } } : {}), source: "naver-daily", source_basis: "naver-daily", security_type: "unknown", target_date: targetDate, started_at: started.toISOString(), retrieved_at: now().toISOString(), license_status: "unconfirmed", market_venue: "unconfirmed", adjustment: "unconfirmed", symbols, sessions, return_history: returnHistory, forecast_model: forecastModel, rank_forecast: rankForecast, rejected: result.rejected, warnings: result.warnings || [], requested: result.requested, elapsed_ms: result.elapsed_ms, durations_ms: result.durations_ms, robots_url: result.robots_url ?? null, robots_status: result.robots_status ?? null, robots_checked_at: result.robots_checked_at ?? null, universe_source: universe.universeSource ?? null, universe_as_of: universe.universeAsOf ?? null, universe_stale: Boolean(universe.universeStale), coverage_status: complete.length === symbols.length ? "complete" : "partial", status: complete.length === symbols.length ? "ready" : "partial", notice: "Unofficial Naver endpoint; market venue, adjustment, publication time and redistribution rights unconfirmed. Daily OHLC can differ from regular-market quotes; comparison conflicts are warnings, not a basis to modify prices." };
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const candidate = await loadNaverDailyHistory({ targetDate, now, path: tempPath });
  if (!candidate.ok) throw new Error(`Candidate cache invalid: ${candidate.reason}`);
  if (original === null) await link(tempPath, path);
  else {
    if (await readFile(path, "utf8") !== original) throw new Error("Cache changed during collection; replacement aborted");
    await rename(tempPath, path);
  }
  return { status: verifyEvening ? "replaced" : record.status, path, targetDate, excluded: symbols.length - complete.length, requested: result.requested, elapsed_ms: result.elapsed_ms };
  } finally {
    await unlink(tempPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  collectDaily({ evening: process.argv.includes("--evening") }).then(async result => {
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `target_date=${result.targetDate ?? ""}
status=${result.status}
`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
