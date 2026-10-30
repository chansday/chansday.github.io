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
// No overall collection deadline: a slow source finishes late rather than
// failing. Each request still has its own 8 s timeout (naver-daily-rows.js).
const RECONSTRUCTION_BUDGET_MS = Infinity;
export const PROGRESS_EVERY = 50;

const duration = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; };

// Progress lines on stdout, which GitHub Actions streams live while the step
// runs: UTC time, KST clock time, and elapsed time since the reconstruction began.
export function createProgressLog({ now = () => new Date(), write = (line) => console.log(line), label = "재현" } = {}) {
  const t0 = now().getTime();
  const log = (message) => {
    const at = now(), kst = new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(11, 19);
    write(`[${label} ${at.toISOString()} | ${kst} KST | +${duration(at.getTime() - t0)}] ${message}`);
  };
  // Times one phase: logs its start, then its end with the phase duration.
  log.phase = async (name, task, summary = () => "") => {
    const started = now().getTime();
    log(`${name} 시작`);
    const result = await task();
    log(`${name} 완료 (${duration(now().getTime() - started)}) ${summary(result)}`.trimEnd());
    return result;
  };
  return log;
}

// Collection progress every PROGRESS_EVERY symbols and on the last one.
export function collectionProgress(log) {
  let maxMs = 0;
  return ({ done, total, symbol, elapsedMs, lastMs, observations, rejected }) => {
    maxMs = Math.max(maxMs, lastMs ?? 0);
    if (done % PROGRESS_EVERY && done !== total) return;
    const perSymbol = elapsedMs / done;
    log(`수집 ${done}/${total} (${Math.round((done / total) * 100)}%) · 경과 ${duration(elapsedMs)} · 남은 예상 ${duration(perSymbol * (total - done))} · 평균 ${(perSymbol / 1000).toFixed(2)}s/종목 · 마지막 요청 ${lastMs ?? "-"}ms (${symbol}) · 최대 요청 ${maxMs}ms · 일봉 ${observations}행 · 제외 ${rejected}건`);
  };
}

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

export async function reconstructDate({ runDate, runId, now = () => new Date(), fetchImpl = globalThis.fetch, sleep, universeLoader = loadKospiUniverseCache, evaluator = runPostCloseEvaluation, budgetMs = RECONSTRUCTION_BUDGET_MS, log = createProgressLog({ now }) }) {
  const dir = repoPath(`data/runs/${runDate}`);
  const stop = (result) => { log(`중단: ${result.status} · ${result.reason}`); return result; };
  log(`${runDate} 재현 시작 (run ${runId})`);
  if (await readJson(`${dir}/1530.json`)) return stop({ status: "not_needed", reason: "stored 1530.json is preserved", wrote: [] });
  const universe = await universeLoader({ now });
  if (!universe.ok) return stop({ status: "blocked", reason: universe.reason, wrote: [] });
  log(`종목 목록 ${universe.symbols.length}종목 (${universe.path || "injected"}, 후보 기준일 ${universe.candidatesAsOf || "-"})`);
  const fetched = await log.phase("일봉 수집", () => fetchDailyCandles({ runDate, symbols: universe.symbols.map((s) => s.symbol), fetchImpl, now, sleep, budgetMs, onProgress: collectionProgress(log) }),
    (r) => `· 상태 ${r.status}${r.reason ? ` (${r.reason})` : ""} · 요청 ${r.requested} · ${runDate} 일봉 ${r.candles.size}종목 · 직전 이력 ${r.history ? `${r.history.valid_symbols.length}종목, 모델 ${r.history.rank_forecast ? "rank" : r.history.forecast_model ? "ridge" : "shrunk"}` : "없음"}`);
  if (!["ready", "partial"].includes(fetched.status) || !fetched.history || !fetched.candles.size) return stop({ status: fetched.status === "blocked" ? "blocked" : "degraded", reason: `Daily candles for ${runDate} unavailable: ${fetched.reason || fetched.status}`, wrote: [] });
  const producedAt = now().toISOString();
  const forecastRows = await log.phase("예측 계산", () => buildForecastRows({ runDate, universe: universe.symbols, history: fetched.history, candles: fetched.candles, zeroVolume: fetched.zeroVolume, recordedAt: producedAt }),
    (rows) => `· ${rows.length}종목 · 예상 종가 ${rows.filter((row) => row.expected_close !== null).length}종목 · 거래 없음 ${rows.filter((row) => row.noTrade).length}종목`);
  const estimated = forecastRows.filter((row) => row.expected_close !== null).length;
  const message = `Reconstructed ${runDate} on ${kstDate(new Date(producedAt))} KST from Naver daily candles: ${forecastRows.length} symbols traded on the date, ${estimated} with an expected close from bars before it. Warning: ${RECONSTRUCTION_CAVEAT}`;
  const { snapshots, invalid } = await log.phase("단계 스냅샷 생성·검증", () => {
    const built = RECONSTRUCTED_STAGES.map((_, index) => buildStageSnapshot({ runDate, runId, producedAt, stageIndex: index, rows: stageRows(forecastRows, RECONSTRUCTED_STAGES[index][1]), fetched, message }));
    return { snapshots: built, invalid: built.find((snapshot) => snapshot.status !== "ready" || !isSnapshot(snapshot)) };
  }, (r) => (r.invalid ? `· 실패: ${r.invalid.meta.run_stage}` : `· ${RECONSTRUCTED_STAGES.length}개 단계 통과`));
  if (invalid) return stop({ status: "degraded", reason: `Reconstructed ${invalid.meta.run_stage} snapshot failed validation: ${invalid.meta.blockedReason || "snapshot contract"}`, wrote: [] });
  await mkdir(dir, { recursive: true });
  const wrote = [];
  await log.phase("파일 쓰기", async () => {
    for (const [index, [label]] of RECONSTRUCTED_STAGES.entries()) {
      const text = `${JSON.stringify(snapshots[index], null, 2)}\n`;
      await writeFile(`${dir}/${label}.json`, text, "utf8");
      wrote.push(`data/runs/${runDate}/${label}.json`);
      log(`  ${label}.json ${(Buffer.byteLength(text) / 1_048_576).toFixed(1)}MB · ${snapshots[index].rows.length}행`);
    }
  });
  const retrospective = await log.phase("사후 평가", async () => {
    try {
      const result = await evaluator({ runDate, runId, stageFile: `${dir}/1530.json`, outputDir: dir, historyFetcher: async () => fetched.history });
      const value = { status: result.status, evaluated: result.evaluated, total: result.total, path: `data/runs/${runDate}/retrospective-${runId}.json` };
      if (result.status === "ready" && !result.preserved) wrote.push(value.path);
      return value;
    } catch (error) { return { status: "failed", reason: error.message }; }
  }, (r) => `· ${r.status}${r.status === "ready" ? ` · ${r.evaluated}/${r.total}종목 평가` : ` · ${r.reason}`}`);
  // Like close catch-up: the latest snapshot follows D only while it still shows D.
  const latestPath = repoPath("data/latest-snapshot.json"), latest = await readJson(latestPath);
  if (latest && latest.meta?.run_date === runDate && latest.asOfDate === runDate) {
    await writeFile(latestPath, `${JSON.stringify(snapshots.at(-1), null, 2)}\n`, "utf8");
    wrote.push("data/latest-snapshot.json");
  }
  await log.phase("날짜 인덱스 갱신", () => buildDateIndex({ root: dataRoot() }));
  wrote.push("data/date-index.json");
  log(`재현 완료 · ${forecastRows.length}종목 · 예상 종가 ${estimated}종목 · 기록 ${wrote.length}개 파일`);
  return { status: "ready", reason: message, rows: forecastRows.length, estimated, wrote, retrospective };
}
