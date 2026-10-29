import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyMarketDate, isValidDate, kstDate, loadMarketCalendar } from "./market-calendar.mjs";
import { dailyHistoryPath, loadNaverDailyHistory, priorTradingDates } from "../providers/naver-daily-cache.js";
import { DAILY_CHART_ENDPOINT, collectNaverDailyRows } from "../providers/naver-daily-rows.js";
import { validateRankingRows } from "../providers/provider-adapter.js";
import { NO_TRADE_STATUS, deriveEvaluationError, deriveExpectedReturn, deriveSessionReturn } from "../providers/evaluation-contract.js";
import { dataRoot, repoPath } from "../providers/repo-paths.js";
import { copyForecastBundle } from "./update-results.mjs";
import { runPostCloseEvaluation } from "./post-close-evaluation.mjs";
import { buildDateIndex } from "./generate-date-index.mjs";

// Missed close-settlement catch-up.
//
// When the 15:30 close-settlement of a past trading day D did not produce
// data/runs/D/1530.json, the polling quote route can no longer observe D's
// close. This builds D's 1530.json from
//   - D's own latest stage file (0900.json, else 0820.json): forecast rows and
//     the recorded FORECAST_BUNDLE, kept only when it was recorded on D
//     (pre-open kinds before 09:00 KST), exactly like the normal settlement;
//   - D's daily candle (open/close/volume) from the committed Naver daily cache
//     (data/daily-history/T.json for the trading days T after D). Only symbols
//     missing there, or the prior history needed by the post-close evaluation,
//     are requested from the same robots-gated api.stock.naver.com chart
//     collector (same host, User-Agent, 500 ms interval, no retry).
// It never overwrites an existing file, never touches another date, and never
// writes the latest snapshot unless it still represents D itself.
export const CATCH_UP_SOURCE = "naver_daily_candle_catch_up";
export const CATCH_UP_SOURCE_ID = "naver-daily-candle-catch-up";
export const MAX_CATCH_UP_TRADING_DAYS = 5;
const FETCH_BUDGET_MS = 25 * 60_000;
const BASE_STAGES = Object.freeze([["0900", "open-settlement"], ["0820", "forecast"]]);
const PRIOR_STAGES = Object.freeze([["0820", "forecast"], ["0800", "analysis"], ["0700", "update-results"]]);
export const CATCH_UP_CAVEAT = "Close settlement caught up after the missed 15:30 run from the Naver daily candle. The Naver daily close may include NXT after-hours trading; market venue, adjustment basis, publication time and redistribution rights are unconfirmed. Source license_status is unconfirmed; preferred shares may be included.";

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function walkTradingDates(date, calendar, step, count) {
  const result = [];
  for (let days = 1; days <= 45 && result.length < count; days += 1) {
    const value = shiftDate(date, step * days), state = classifyMarketDate(value, calendar);
    if (state.status === "error") break;
    if (state.status === "run") result.push(value);
  }
  return result;
}

// The `count` trading days before `today`, oldest first.
export function previousTradingDates(today, calendar, count = MAX_CATCH_UP_TRADING_DAYS) {
  return walkTradingDates(today, calendar, -1, count).reverse();
}

export function catchUpEligibility(runDate, today, calendar) {
  if (!isValidDate(runDate)) return { eligible: false, reason: "invalid_date" };
  if (runDate >= today) return { eligible: false, reason: "not_a_past_date" };
  if (classifyMarketDate(runDate, calendar).status !== "run") return { eligible: false, reason: "not_a_trading_day" };
  if (!previousTradingDates(today, calendar).includes(runDate)) return { eligible: false, reason: `older_than_${MAX_CATCH_UP_TRADING_DAYS}_trading_days` };
  return { eligible: true, reason: null };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

const runFile = (runDate, label) => repoPath(`data/runs/${runDate}/${label}.json`);

function genuineStage(snapshot, runDate, stage) {
  return Boolean(snapshot && snapshot.meta?.run_date === runDate && snapshot.meta?.run_stage === stage && snapshot.asOfDate === runDate
    && snapshot.mode === "provider" && snapshot.provider?.id === "naver-crawl" && !snapshot.meta?.historical_test && !snapshot.meta?.test_only
    && Array.isArray(snapshot.rows) && snapshot.rows.length > 0);
}

function kstClock(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const kst = new Date(t + 9 * 3_600_000).toISOString();
  return { date: kst.slice(0, 10), time: kst.slice(11, 19) };
}

// A recorded opening counts only if it was recorded on D: pre-open kinds before
// 09:00 KST, retrospective history on D. Returns the row carrying the bundle
// (a legacy pre-open quote gets the explicit source the normal stage gives it).
function recordedOpening(row, runDate) {
  if (!(row?.expected_open > 0)) return null;
  const src = row.expected_open_source;
  if (src) {
    const at = kstClock(src.recorded_at);
    if (!at || at.date !== runDate) return null;
    if (["preopen_quote", "preopen_history"].includes(src.kind)) return at.time < "09:00:00" ? row : null;
    return src.kind === "retrospective_history" ? row : null;
  }
  const at = kstClock(row.quote_at);
  if (row.market_status === "PREOPEN" && row.quality === "naver_preopen_quote" && at?.date === runDate && at.time < "09:00:00") {
    return { ...row, expected_open_source: { kind: "preopen_quote", recorded_at: row.quote_at, history_dates: [] } };
  }
  return null;
}

function stripOpening(row) {
  row.expected_open = null;
  delete row.expected_open_source; delete row.expected_open_basis;
  if (row.expected_close_basis) { row.expected_close = null; delete row.expected_close_basis; }
  return row;
}

export async function loadCatchUpBase(runDate) {
  for (const [label, stage] of BASE_STAGES) {
    const snapshot = await readJson(runFile(runDate, label));
    if (genuineStage(snapshot, runDate, stage)) return { label, stage, snapshot };
  }
  return null;
}

async function loadPriorOpenings(runDate) {
  const openings = new Map();
  for (const [label, stage] of PRIOR_STAGES) {
    const snapshot = await readJson(runFile(runDate, label));
    if (!genuineStage(snapshot, runDate, stage)) continue;
    for (const row of snapshot.rows) {
      const recorded = row.symbol && !openings.has(row.symbol) ? recordedOpening(row, runDate) : null;
      if (recorded) openings.set(row.symbol, recorded);
    }
  }
  return openings;
}

// D's candles from the committed daily caches of the trading days after D.
export async function loadCachedCandles({ runDate, today, calendar, now = () => new Date() }) {
  const candles = new Map(), files = [], zeroVolume = new Set();
  let retrievedAt = null, robots = null;
  for (const target of walkTradingDates(runDate, calendar, 1, 3).filter((date) => date <= today)) {
    const history = await loadNaverDailyHistory({ targetDate: target, now });
    if (!history.ok || !history.sessions.some((s) => s.date === runDate)) continue;
    // The loader keeps only symbols with all three sessions; D's own rows were
    // validated by it too, so a symbol missing an older session still settles.
    const record = await readJson(dailyHistoryPath(target));
    const session = record?.sessions?.find((s) => s.date === runDate);
    if (!session) continue;
    files.push(`data/daily-history/${target}.json`);
    retrievedAt ||= history.retrieved_at;
    robots ||= { robots_url: history.robots_url, robots_checked_at: history.robots_checked_at, robots_status: history.robots_status };
    for (const row of session.rows) if (!candles.has(row.symbol)) candles.set(row.symbol, row);
    for (const r of Array.isArray(record.rejected) ? record.rejected : []) if (r?.reason === "zero_volume" && r.date === runDate && record.symbols?.includes(r.symbol)) zeroVolume.add(r.symbol);
  }
  return { candles, files, retrievedAt, robots, zeroVolume };
}

// One robots-gated chart request per symbol; the window ends on D, so D's
// candle and its three prior sessions come from the same response.
export async function fetchDailyCandles({ runDate, symbols, fetchImpl, now = () => new Date(), sleep, clock = Date.now, budgetMs = FETCH_BUDGET_MS }) {
  const collected = await collectNaverDailyRows({ symbols, targetDate: shiftDate(runDate, 1), fetchImpl, now, clock, deadline: clock() + budgetMs, ...(sleep ? { sleep } : {}) });
  const observations = Array.isArray(collected.observations) ? collected.observations : [];
  const candles = new Map(observations.filter((row) => row.date === runDate).map((row) => [row.symbol, row]));
  let history = null;
  try {
    const dates = await priorTradingDates(runDate);
    const maps = dates.map((date) => new Map(observations.filter((row) => row.date === date).map((row) => [row.symbol, row])));
    const valid = symbols.filter((symbol) => maps.every((map) => map.has(symbol)));
    if (valid.length) {
      history = { ok: true, source: "naver-daily", source_basis: "naver-daily", security_type: "unknown",
        sessions: dates.map((date, i) => ({ date, url: DAILY_CHART_ENDPOINT, rows: valid.map((symbol) => maps[i].get(symbol)) })),
        symbols, valid_symbols: valid, retrieved_at: now().toISOString(), excluded_count: symbols.length - valid.length, comparison_conflicts: 0, partial: valid.length !== symbols.length,
        robots_url: collected.robots_url ?? null, robots_checked_at: collected.robots_checked_at ?? null, robots_status: collected.robots_status ?? null, fetched_after_close: true };
    }
  } catch { history = null; }
  const zeroVolume = new Set((Array.isArray(collected.rejected) ? collected.rejected : []).filter((r) => r?.reason === "zero_volume" && r.date === runDate).map((r) => r.symbol));
  return { status: collected.status, reason: collected.reason || null, requested: collected.requested ?? 0, candles, history, zeroVolume,
    robots: { robots_url: collected.robots_url ?? null, robots_checked_at: collected.robots_checked_at ?? null, robots_status: collected.robots_status ?? null } };
}

function rankBySessionReturn(rows) {
  rows.sort((a, b) => (b.session_return ?? -Infinity) - (a.session_return ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

// Pure builder: the 1530 snapshot for D from its base stage file and candles.
// No-trade evidence for D, never inferred from missing values: the daily
// candle rejected for volume 0, or a same-date stored row carrying the polling
// halt marker. A halt observed today does not prove D was halted.
export function noTradeEvidence(baseRow, runDate, zeroVolume = new Set()) {
  if (zeroVolume.has(baseRow.symbol)) return { source: "naver_daily_candle", volume: 0, dates: [runDate], reason: `Naver daily candle for ${runDate} reports volume 0 (likely halted)` };
  const e = baseRow.no_trade_evidence;
  if (baseRow.trading_status === NO_TRADE_STATUS && e?.source === "naver_polling_quote" && (e.trade_stop_type === "HALTED" || e.tradable_status === "halt") && kstClock(e.observed_at)?.date === runDate) return { ...e };
  return null;
}

export function buildCatchUpSnapshot({ runDate, base, priorOpenings = new Map(), candles, zeroVolume = new Set(), producedAt, runId, candleSource, fetchStatus = null, fetchReason = null, cacheFiles = [], retrievedAt = null, robots = null, fetched = 0 }) {
  const rows = rankBySessionReturn(base.snapshot.rows.filter((row) => row.symbol).map((baseRow) => {
    const row = { ...baseRow };
    const recorded = recordedOpening(baseRow, runDate) || priorOpenings.get(baseRow.symbol) || null;
    if (recorded) copyForecastBundle(row, recorded); else stripOpening(row);
    if (recorded && !Object.hasOwn(row, "expected_close")) row.expected_close = null;
    const candle = candles.get(baseRow.symbol);
    row.actual_open = candle ? candle.open : null;
    row.actual_close = candle ? candle.close : null;
    row.actual_volume = candle ? candle.volume : null;
    row.session_return = deriveSessionReturn(row);
    row.expected_return = deriveExpectedReturn(row);
    row.error = deriveEvaluationError(row);
    row.quality = candle ? "naver_daily_candle_catch_up" : "naver_daily_candle_missing";
    row.quote_at = null; row.quote_age_seconds = null; row.market_status = null;
    delete row.trading_status; delete row.no_trade_evidence;
    const evidence = candle ? null : noTradeEvidence(baseRow, runDate, zeroVolume);
    if (evidence) Object.assign(row, { actual_volume: null, session_return: null, error: null, quality: "naver_no_trade_observed", trading_status: NO_TRADE_STATUS, no_trade_evidence: evidence });
    return row;
  }));
  const settled = rows.filter((row) => row.actual_open > 0 && row.actual_close > 0).length;
  const noTrade = rows.filter((row) => row.trading_status === NO_TRADE_STATUS).length;
  const missing = rows.length - settled - noTrade;
  const validation = validateRankingRows(rows, { koreanSymbols: true });
  let status;
  if (!rows.length) status = "no_data";
  else if (!validation.valid) status = "degraded";
  else if (!missing) status = "ready";
  else if (fetchStatus === "blocked") status = "blocked";
  else status = settled ? "partial" : fetchStatus === "degraded" ? "degraded" : "no_data";
  const producedKst = kstDate(new Date(producedAt));
  const message = `${status === "ready" ? "Settled" : "Could not fully settle"} ${settled}/${rows.length} rows for ${runDate} from the Naver daily candle (${candleSource}) on ${producedKst} KST after the missed close-settlement.${noTrade ? ` ${noTrade} symbol(s) are no_trade_observed (source halt marker or zero-volume candle) and are kept without prices or error.` : ""}${missing ? ` ${missing} symbol(s) have no valid daily candle for ${runDate}.` : ""}${fetchStatus && fetchStatus !== "ready" ? ` Daily chart request ${fetchStatus}${fetchReason ? `: ${fetchReason}` : ""}.` : ""}${validation.valid ? "" : ` Row validation failed: ${validation.reason}`} Warning: ${CATCH_UP_CAVEAT}`;
  const source = {
    name: "네이버 증권 일봉 차트 (비공식) · 누락 마감 정산 보충",
    url: DAILY_CHART_ENDPOINT,
    license_status: "unconfirmed",
    license_url: null,
    retrieved_at: retrievedAt || producedAt,
    source_id: CATCH_UP_SOURCE_ID,
    run_id: runId,
    status,
    fetched_at: retrievedAt || producedAt,
    source_date: runDate,
    raw_rows: candles.size,
    source_rows: settled,
    partial: status !== "ready",
    metrics: { candle_source: candleSource, cache_files: cacheFiles, fetched_requests: fetched, fetch_status: fetchStatus, missing_candles: missing, no_trade_count: noTrade, robots_url: robots?.robots_url ?? null, robots_checked_at: robots?.robots_checked_at ?? null, robots_status: robots?.robots_status ?? null, market_venue: "unconfirmed (may include NXT after-hours)", adjustment: "unconfirmed" },
  };
  return {
    ...base.snapshot,
    status,
    mode: "provider",
    asOfDate: runDate,
    publishedAt: status === "ready" ? producedAt : null,
    provider: { id: "naver-crawl", status, label: "NAVER DAILY CANDLE · CLOSE CATCH-UP · UNOFFICIAL", source: { ...source, retrieved_at: null } },
    rows: validation.valid ? validation.rows : rows,
    meta: {
      ...base.snapshot.meta,
      lastAttemptAt: producedAt,
      lastAttemptMode: "close-settlement",
      run_date: runDate,
      run_stage: "close-settlement",
      run_id: runId,
      blockedReason: status === "ready" ? null : message,
      source_warning: CATCH_UP_CAVEAT,
      isDemo: false,
      source,
      settlement_source: CATCH_UP_SOURCE,
      catch_up: { produced_at: producedAt, produced_kst_date: producedKst, base_stage: base.label, base_run_id: base.snapshot.meta?.run_id ?? null, candle_source: candleSource, cache_files: cacheFiles, settled_rows: settled, missing_candles: missing, no_trade_count: noTrade },
    },
    pipeline: { ...base.snapshot.pipeline, closeSettlement: { status, attemptedAt: producedAt, provider_id: "naver-crawl", message } },
  };
}

async function writeNew(path, value) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); return true; }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
}

export async function catchUpDate({ runDate, today, calendar, now = () => new Date(), runId, fetchImpl = globalThis.fetch, allowFetch = true, sleep, dryRun = false, evaluator = runPostCloseEvaluation }) {
  const eligibility = catchUpEligibility(runDate, today, calendar);
  if (!eligibility.eligible) return { runDate, status: "skipped", reason: eligibility.reason, wrote: [] };
  const stagePath = runFile(runDate, "1530");
  if (await readJson(stagePath)) return { runDate, status: "not_needed", reason: "existing 1530.json is preserved", wrote: [] };
  const base = await loadCatchUpBase(runDate);
  if (!base) return { runDate, status: "no_data", reason: "no same-date 0900/0820 stage file; nothing to settle", wrote: [] };
  const symbols = base.snapshot.rows.map((row) => row.symbol).filter(Boolean);
  const cached = await loadCachedCandles({ runDate, today, calendar, now });
  const cachedHistory = await loadNaverDailyHistory({ targetDate: runDate, now });
  const baseNoTrade = new Set(base.snapshot.rows.filter((row) => noTradeEvidence(row, runDate, cached.zeroVolume)).map((row) => row.symbol));
  const missingSymbols = symbols.filter((symbol) => !cached.candles.has(symbol) && !baseNoTrade.has(symbol));
  let fetched = null;
  const needFetch = missingSymbols.length > 0 || !cachedHistory.ok;
  if (needFetch && allowFetch) {
    fetched = await fetchDailyCandles({ runDate, symbols: cachedHistory.ok ? missingSymbols : symbols, fetchImpl, now, sleep });
  }
  const candles = new Map(cached.candles);
  for (const [symbol, row] of fetched?.candles || []) if (!candles.has(symbol)) candles.set(symbol, row);
  const zeroVolume = new Set([...cached.zeroVolume, ...(fetched?.zeroVolume || [])]);
  const usedFetch = Boolean(fetched && [...fetched.candles.keys()].some((symbol) => !cached.candles.has(symbol)));
  const candleSource = cached.candles.size && usedFetch ? "cache+chart_request" : usedFetch ? "chart_request" : cached.candles.size ? "cache" : "none";
  const producedAt = now().toISOString();
  const snapshot = buildCatchUpSnapshot({ runDate, base, priorOpenings: await loadPriorOpenings(runDate), candles, zeroVolume, producedAt, runId, candleSource,
    fetchStatus: fetched?.status ?? (needFetch && !allowFetch && missingSymbols.length ? "not_requested" : null), fetchReason: fetched?.reason ?? null,
    cacheFiles: cached.files, retrievedAt: usedFetch ? producedAt : cached.retrievedAt, robots: fetched?.robots?.robots_url ? fetched.robots : cached.robots, fetched: fetched?.requested ?? 0 });
  const summary = { runDate, status: snapshot.status, reason: snapshot.pipeline.closeSettlement.message, base: base.label, rows: snapshot.rows.length,
    settled: snapshot.meta.catch_up.settled_rows, missing: snapshot.meta.catch_up.missing_candles, noTrade: snapshot.meta.catch_up.no_trade_count, evaluable: snapshot.rows.filter((row) => row.error !== null).length,
    candleSource, fetchStatus: fetched?.status ?? null, priorHistory: cachedHistory.ok ? "cache" : fetched?.history ? "chart_request" : "unavailable", wrote: [], retrospective: { status: "not_run" } };
  if (dryRun || snapshot.status !== "ready") return { ...summary, ...(dryRun ? { dryRun: true, snapshot } : {}) };
  if (!await writeNew(stagePath, snapshot)) return { ...summary, status: "not_needed", reason: "1530.json appeared concurrently and was preserved" };
  summary.wrote.push(`data/runs/${runDate}/1530.json`);
  // Same post-close evaluation as the normal settlement; prior history comes
  // from D's committed cache, else from the chart response fetched above.
  const historyFetcher = async ({ targetDate }) => (cachedHistory.ok ? cachedHistory : fetched?.history && targetDate === runDate ? fetched.history : cachedHistory);
  try {
    const result = await evaluator({ runDate, runId, stageFile: stagePath, outputDir: repoPath(`data/runs/${runDate}`), historyFetcher });
    summary.retrospective = { status: result.status, evaluated: result.evaluated, total: result.total };
    if (result.status === "ready" && !result.preserved) summary.wrote.push(`data/runs/${runDate}/retrospective-${runId}.json`);
  } catch (error) { summary.retrospective = { status: "failed", reason: error.message }; }
  // The latest snapshot moves to D's settlement only while it still shows D.
  const latestPath = repoPath("data/latest-snapshot.json");
  const latest = await readJson(latestPath);
  if (latest && latest.meta?.run_date === runDate && latest.asOfDate === runDate && latest.meta?.run_stage !== "close-settlement") {
    await writeFile(latestPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    summary.wrote.push("data/latest-snapshot.json");
  }
  await buildDateIndex({ root: dataRoot() });
  summary.wrote.push("data/date-index.json");
  return summary;
}

// Dates to settle: the requested ones, else every recent trading day whose
// 1530.json is missing while a same-date 0900/0820 file exists.
export async function missingCloseSettlementDates({ today, calendar }) {
  const dates = [];
  for (const date of previousTradingDates(today, calendar)) {
    if (await readJson(runFile(date, "1530"))) continue;
    if (await loadCatchUpBase(date)) dates.push(date);
  }
  return dates;
}

const STATUS_ORDER = ["ready", "not_needed", "skipped", "partial", "no_data", "degraded", "blocked"];

export async function runCatchUp({ dates = [], now = () => new Date(), calendar = null, ...options } = {}) {
  const cal = calendar || await loadMarketCalendar();
  const today = kstDate(now());
  const targets = dates.length ? [...new Set(dates)].sort() : await missingCloseSettlementDates({ today, calendar: cal });
  const results = [];
  for (const runDate of targets) results.push(await catchUpDate({ runDate, today, calendar: cal, now, ...options }));
  const worst = results.reduce((acc, r) => (STATUS_ORDER.indexOf(r.status) > STATUS_ORDER.indexOf(acc) ? r.status : acc), results.some((r) => r.status === "ready") ? "ready" : "not_needed");
  const status = worst === "skipped" && dates.length ? "blocked" : worst === "skipped" ? "not_needed" : worst;
  const wrote = results.flatMap((r) => r.wrote || []);
  const retrospectiveFailed = results.some((r) => r.status === "ready" && r.retrospective?.status !== "ready" && !options.dryRun);
  return { status, today, requested: dates, results, wrote, retrospective: retrospectiveFailed ? "failed" : results.some((r) => r.retrospective?.status === "ready") ? "ready" : "not_run" };
}

function parseDates(value) {
  return String(value || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const dates = [...parseDates(process.env.KOSPI_CATCH_UP_DATES)];
  for (let i = 0; i < args.length; i += 1) if (args[i] === "--run-date") dates.push(...parseDates(args[++i]));
  const runId = process.env.KOSPI_RUN_ID || `local-catch-up-${Date.now()}`;
  (async () => {
    if (dates.some((date) => !isValidDate(date))) throw new Error(`run_date must be YYYY-MM-DD (comma-separated for several): ${dates.join(",")}`);
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("Invalid run ID");
    const outcome = await runCatchUp({ dates, runId, dryRun: args.includes("--dry-run"), allowFetch: !args.includes("--no-fetch") });
    const printable = { ...outcome, results: outcome.results.map(({ snapshot, ...rest }) => rest) };
    console.log(JSON.stringify(printable, null, 2));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${outcome.status}\nwrote=${outcome.wrote.length > 0}\nretrospective=${outcome.retrospective}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, [`### KOSPI close-settlement catch-up`, `- status: \`${outcome.status}\``, ...outcome.results.map((r) => `- ${r.runDate}: \`${r.status}\`${r.rows !== undefined ? ` ${r.settled}/${r.rows} rows from ${r.candleSource}; retrospective ${r.retrospective?.status}` : ""} — ${String(r.reason || "").replaceAll("\n", " ")}`), ""].join("\n"));
    if (!["ready", "not_needed"].includes(outcome.status)) process.exitCode = 2;
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
