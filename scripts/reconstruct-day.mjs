// Past-date reconstruction for run all now: a trading day D without a stored
// close settlement gets all five stage files rebuilt from Naver daily candles,
// as if the day had been analysed live. Forecasts use only bars before D (the
// same engine and models as the 06:10 collector); actual values come from D's
// own candle. Existing stage files of D are overwritten; a stored 1530.json is
// never touched (run all now re-evaluates it instead).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { kstDate } from "./market-calendar.mjs";
import { fetchDailyCandles, noTradeEvidence } from "./close-catch-up.mjs";
import { runPostCloseEvaluation } from "./post-close-evaluation.mjs";
import { buildDateIndex } from "./generate-date-index.mjs";
import { loadKospiUniverseCache } from "../providers/kospi-universe-cache.js";
import { DAILY_CHART_ENDPOINT } from "../providers/naver-daily-rows.js";
import { priorHistoryEstimate } from "../providers/forecast-basis.js";
import { isSnapshot, validateRankingRows } from "../providers/provider-adapter.js";
import { compareByExpectedReturn, deriveEvaluationError, deriveExpectedReturn, deriveSessionReturn } from "../providers/evaluation-contract.js";
import { withEvaluationScores } from "../providers/evaluation-score.js";
import { dataRoot, repoPath } from "../providers/repo-paths.js";

export const RECONSTRUCTION_SOURCE_ID = "naver-daily-candle-reconstruction";
export const RECONSTRUCTION_CAVEAT = "Reconstructed after the trading day from Naver daily candles: forecasts use only bars before the date, actual values are the date's daily candle. The Naver daily close may include NXT after-hours trading; market venue, adjustment basis, publication time and redistribution rights are unconfirmed. The universe is the current committed list, so symbols delisted since are absent. Source license_status is unconfirmed; preferred shares may be included.";
// [file label, run_stage, pipeline key]; the stage order of a live day.
export const RECONSTRUCTED_STAGES = Object.freeze([
  ["0700", "update-results", "previousResult"],
  ["0800", "analysis", "analysis"],
  ["0820", "forecast", "forecast"],
  ["0900", "open-settlement", "openSettlement"],
  ["1530", "close-settlement", "closeSettlement"],
]);
const RECONSTRUCTION_BUDGET_MS = 30 * 60_000;

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Forecast rows for D: one per symbol that traded (or was halted) on D.
export function buildForecastRows({ runDate, universe, history, candles, zeroVolume, recordedAt }) {
  const historyDates = history.sessions.map((session) => session.date);
  return universe.filter(({ symbol }) => candles.has(symbol) || zeroVolume.has(symbol)).map(({ symbol, name }) => {
    const estimate = priorHistoryEstimate(history.sessions, symbol, { returnHistory: history.return_history?.[symbol] ?? null, forecastModel: history.forecast_model ?? null, rankForecast: history.rank_forecast ?? null });
    const row = { rank: null, symbol, name, expected_open: estimate?.expected_open ?? null, expected_close: estimate?.expected_close ?? null };
    if (estimate) {
      row.expected_open_source = { kind: "retrospective_history", recorded_at: recordedAt, history_dates: historyDates };
      row.expected_open_basis = estimate.open_basis;
      if (estimate.close_basis) row.expected_close_basis = estimate.close_basis;
    }
    return { ...row, candle: candles.get(symbol) ?? null, noTrade: candles.has(symbol) ? null : noTradeEvidence({ symbol }, runDate, zeroVolume) };
  });
}

// The stage file rows: actual values appear from 09:00 (open) and 15:30 (close).
export function stageRows(forecastRows, stage) {
  const open = stage === "open-settlement" || stage === "close-settlement", close = stage === "close-settlement";
  const rows = forecastRows.map(({ candle, noTrade, ...base }) => {
    const row = { ...base, expected_return: null, actual_open: open && candle ? candle.open : null, actual_close: close && candle ? candle.close : null, actual_return: null,
      actual_volume: close && candle ? candle.volume : null, ...(close ? { actual_high: candle?.high ?? null, actual_low: candle?.low ?? null } : {}),
      session_return: null, intraday_reference_return: null, error: null, confidence: null, quality: "naver_daily_candle_reconstruction", status: "valid", quote_at: null, quote_age_seconds: null, market_status: null };
    row.expected_return = deriveExpectedReturn(row);
    row.session_return = deriveSessionReturn(row);
    row.error = deriveEvaluationError(row);
    if (noTrade && open) Object.assign(row, { quality: "naver_no_trade_observed", trading_status: "no_trade_observed", no_trade_evidence: noTrade });
    return row;
  });
  rows.sort(compareByExpectedReturn);
  rows.forEach((row, index) => { row.rank = index + 1; });
  return withEvaluationScores(rows);
}

export function buildStageSnapshot({ runDate, runId, producedAt, stageIndex, rows, fetched, message }) {
  const [, stage] = RECONSTRUCTED_STAGES[stageIndex];
  const validation = validateRankingRows(rows, { koreanSymbols: true });
  const status = validation.valid ? "ready" : "degraded";
  const source = { name: "네이버 증권 일봉 차트 (비공식) · 과거 거래일 재현", url: DAILY_CHART_ENDPOINT, license_status: "unconfirmed", license_url: null, retrieved_at: producedAt,
    source_id: RECONSTRUCTION_SOURCE_ID, run_id: runId, status, fetched_at: producedAt, source_date: runDate, raw_rows: rows.length, source_rows: rows.length, partial: false,
    metrics: { fetched_requests: fetched.requested, fetch_status: fetched.status, robots_url: fetched.robots?.robots_url ?? null, robots_checked_at: fetched.robots?.robots_checked_at ?? null, robots_status: fetched.robots?.robots_status ?? null, market_venue: "unconfirmed (may include NXT after-hours)", adjustment: "unconfirmed" } };
  const pipeline = Object.fromEntries(RECONSTRUCTED_STAGES.map(([, , key], index) => [key, index <= stageIndex ? { status, attemptedAt: producedAt, provider_id: "naver-crawl", message } : { status: "pending", attemptedAt: null, provider_id: null, message: null }]));
  return {
    schemaVersion: "1.0.0", status, mode: "provider", asOfDate: runDate, publishedAt: status === "ready" ? producedAt : null,
    market: { name: "KOSPI", currency: "KRW", timezone: "Asia/Seoul" },
    provider: { id: "naver-crawl", status, label: "NAVER DAILY CANDLE · RECONSTRUCTED · UNOFFICIAL", source: { ...source, retrieved_at: null } },
    pipeline,
    rows: validation.valid ? validation.rows : rows,
    meta: { generatedBy: "reconstruct-day", lastAttemptAt: producedAt, lastAttemptMode: stage, blockedReason: status === "ready" ? null : `Row validation failed: ${validation.reason}`, isDemo: false, source,
      run_date: runDate, run_stage: stage, run_id: runId, source_warning: RECONSTRUCTION_CAVEAT, reconstruction: { produced_at: producedAt, produced_kst_date: kstDate(new Date(producedAt)), history_dates: fetched.history.sessions.map((s) => s.date), model: rows.find((r) => r.expected_close_basis)?.expected_close_basis.model ?? null } },
  };
}

export async function reconstructDate({ runDate, runId, now = () => new Date(), fetchImpl = globalThis.fetch, sleep, universeLoader = loadKospiUniverseCache, evaluator = runPostCloseEvaluation, budgetMs = RECONSTRUCTION_BUDGET_MS }) {
  const dir = repoPath(`data/runs/${runDate}`);
  if (await readJson(`${dir}/1530.json`)) return { status: "not_needed", reason: "stored 1530.json is preserved", wrote: [] };
  const universe = await universeLoader({ now });
  if (!universe.ok) return { status: "blocked", reason: universe.reason, wrote: [] };
  const fetched = await fetchDailyCandles({ runDate, symbols: universe.symbols.map((s) => s.symbol), fetchImpl, now, sleep, budgetMs });
  if (!["ready", "partial"].includes(fetched.status) || !fetched.history || !fetched.candles.size) return { status: fetched.status === "blocked" ? "blocked" : "degraded", reason: `Daily candles for ${runDate} unavailable: ${fetched.reason || fetched.status}`, wrote: [] };
  const producedAt = now().toISOString();
  const forecastRows = buildForecastRows({ runDate, universe: universe.symbols, history: fetched.history, candles: fetched.candles, zeroVolume: fetched.zeroVolume, recordedAt: producedAt });
  const estimated = forecastRows.filter((row) => row.expected_close !== null).length;
  const message = `Reconstructed ${runDate} on ${kstDate(new Date(producedAt))} KST from Naver daily candles: ${forecastRows.length} symbols traded on the date, ${estimated} with an expected close from bars before it. Warning: ${RECONSTRUCTION_CAVEAT}`;
  const snapshots = RECONSTRUCTED_STAGES.map((_, index) => buildStageSnapshot({ runDate, runId, producedAt, stageIndex: index, rows: stageRows(forecastRows, RECONSTRUCTED_STAGES[index][1]), fetched, message }));
  const invalid = snapshots.find((snapshot) => snapshot.status !== "ready" || !isSnapshot(snapshot));
  if (invalid) return { status: "degraded", reason: `Reconstructed ${invalid.meta.run_stage} snapshot failed validation: ${invalid.meta.blockedReason || "snapshot contract"}`, wrote: [] };
  await mkdir(dir, { recursive: true });
  const wrote = [];
  for (const [index, [label]] of RECONSTRUCTED_STAGES.entries()) {
    await writeFile(`${dir}/${label}.json`, `${JSON.stringify(snapshots[index], null, 2)}\n`, "utf8");
    wrote.push(`data/runs/${runDate}/${label}.json`);
  }
  let retrospective;
  try {
    const result = await evaluator({ runDate, runId, stageFile: `${dir}/1530.json`, outputDir: dir, historyFetcher: async () => fetched.history });
    retrospective = { status: result.status, evaluated: result.evaluated, total: result.total, path: `data/runs/${runDate}/retrospective-${runId}.json` };
    if (result.status === "ready" && !result.preserved) wrote.push(retrospective.path);
  } catch (error) { retrospective = { status: "failed", reason: error.message }; }
  // Like close catch-up: the latest snapshot follows D only while it still shows D.
  const latestPath = repoPath("data/latest-snapshot.json"), latest = await readJson(latestPath);
  if (latest && latest.meta?.run_date === runDate && latest.asOfDate === runDate) {
    await writeFile(latestPath, `${JSON.stringify(snapshots.at(-1), null, 2)}\n`, "utf8");
    wrote.push("data/latest-snapshot.json");
  }
  await buildDateIndex({ root: dataRoot() });
  wrote.push("data/date-index.json");
  return { status: "ready", reason: message, rows: forecastRows.length, estimated, wrote, retrospective };
}
