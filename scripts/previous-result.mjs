import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classifyMarketDate, isValidDate, loadMarketCalendar } from "./market-calendar.mjs";
import { isNoTradeEvidence } from "../providers/provider-adapter.js";

export function previousTradingDate(date, calendar) {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  let current = new Date(`${date}T00:00:00Z`);
  for (let i = 0; i < 370; i += 1) {
    current.setUTCDate(current.getUTCDate() - 1);
    const candidate = current.toISOString().slice(0, 10);
    // Check coverage even for weekends: crossing the boundary must fail closed.
    if (candidate < calendar.coverage.start || candidate > calendar.coverage.end) throw new Error(`Calendar does not cover ${candidate}`);
    if (classifyMarketDate(candidate, calendar).status === "run") return candidate;
  }
  throw new Error("Previous trading day not found");
}

export async function evaluatePreviousResult(runDate, attemptedAt) {
  let targetDate;
  try { targetDate = previousTradingDate(runDate, await loadMarketCalendar()); }
  catch (error) { return { status: "blocked", targetDate: null, message: `거래일 달력 확인 실패: ${error.message}` }; }
  let saved;
  try { saved = JSON.parse(await readFile(resolve("data", "runs", targetDate, "1530.json"), "utf8")); }
  catch (error) { return { status: "blocked", targetDate, message: `${targetDate} 종가 정산 기록을 읽을 수 없습니다: ${error.code || "invalid_json"}` }; }
  const step = saved.pipeline?.closeSettlement;
  const source = saved.meta?.source;
  const when = Date.parse(step?.attemptedAt);
  const closeStart = Date.parse(`${targetDate}T06:31:00Z`);
  const reference = Date.parse(attemptedAt);
  const retrieved = Date.parse(source?.retrieved_at);
  if (saved.mode !== "provider" || saved.provider?.id !== "naver-crawl" || saved.asOfDate !== targetDate || saved.meta?.run_date !== targetDate || saved.meta?.run_stage !== "close-settlement" || saved.meta?.test_only || saved.meta?.historical_test || saved.meta?.settlement_source || !["ready", "partial"].includes(step?.status) || source?.source_id !== "naver-public-polling-crawl" || source?.source_date !== targetDate || !Number.isFinite(when) || when < closeStart || when > reference || !Number.isFinite(retrieved) || retrieved < closeStart || retrieved > reference || !Array.isArray(saved.rows) || !saved.rows.length) {
    return { status: "blocked", targetDate, message: `${targetDate} 정산의 날짜·출처·상태 또는 15:31 이후 수집을 확인할 수 없습니다.` };
  }
  // A symbol intentionally excluded during pre-open forecasting may trade later.
  // Consult the original dated forecast; never infer this from missing prices.
  let forecastExclusions = new Set();
  try {
    const content = await readFile(resolve("data", "runs", targetDate, "0835.json"), "utf8").catch(e => { if (e.code === "ENOENT") return readFile(resolve("data", "runs", targetDate, "0820.json"), "utf8"); throw e; });
    const forecast = JSON.parse(content);
    const forecastAt = Date.parse(forecast.pipeline?.forecast?.attemptedAt);
    const fetchedAt = Date.parse(forecast.meta?.source?.retrieved_at);
    const dayStart = Date.parse(`${targetDate}T00:00:00+09:00`);
    const open = Date.parse(`${targetDate}T09:00:00+09:00`);
    if (forecast.mode === "provider" && forecast.provider?.id === "naver-crawl"
      && forecast.asOfDate === targetDate && forecast.meta?.run_date === targetDate && forecast.meta?.run_stage === "forecast"
      && !forecast.meta?.test_only && !forecast.meta?.historical_test
      && forecast.meta?.source?.source_id === "naver-public-polling-crawl"
      && forecast.meta?.source?.source_date === targetDate && ["ready", "partial"].includes(forecast.pipeline?.forecast?.status)
      && Number.isFinite(forecastAt) && forecastAt >= dayStart && forecastAt < open
      && Number.isFinite(fetchedAt) && fetchedAt >= forecastAt && fetchedAt < open && Array.isArray(forecast.rows)) {
      const counts = new Map();
      for (const row of forecast.rows) counts.set(row.symbol, (counts.get(row.symbol) || 0) + 1);
      forecastExclusions = new Set(forecast.rows.filter(row => counts.get(row.symbol) === 1 && isNoTradeEvidence(row)
        && row.expected_open === null && row.expected_close === null).map(row => row.symbol));
    }
  } catch { /* Missing or invalid forecast cannot justify an exclusion. */ }
  let compared = 0, missing = 0, excluded = 0, forecastExcluded = 0, sum = 0;
  const symbols = new Set();
  for (const row of saved.rows) {
    if (!/^\d{6}$/.test(row.symbol || "") || symbols.has(row.symbol)) { missing += 1; continue; }
    symbols.add(row.symbol);
    if (row.trading_status === "no_trade_observed") { if (isNoTradeEvidence(row)) excluded += 1; else missing += 1; continue; }
    if (row.actual_open > 0 && row.actual_close > 0 && row.expected_open === null && row.expected_close === null
      && forecastExclusions.has(row.symbol)) { forecastExcluded += 1; continue; }
    const quoteAt = Date.parse(row.close_quote_at);
    const observed = quoteAt + row.close_quote_age_seconds * 1000;
    const predictionAt = Date.parse(saved.meta?.close_model?.scored_at || row.expected_open_source?.recorded_at);
    const isRecorded = row.expected_open_source?.kind !== "retrospective_history" && saved.meta?.close_model?.backfill !== true
      && Number.isFinite(predictionAt) && predictionAt >= Date.parse(`${targetDate}T00:00:00+09:00`) && predictionAt < closeStart;
    if (!(row.actual_open > 0 && row.actual_close > 0 && row.expected_open > 0 && row.expected_close > 0) || row.close_basis !== "krx_regular"
      || !Number.isFinite(quoteAt) || !Number.isFinite(row.close_quote_age_seconds) || row.close_quote_age_seconds < 0
      || quoteAt < Date.parse(`${targetDate}T00:00:00+09:00`) || quoteAt > retrieved
      || observed < closeStart || observed >= Date.parse(`${targetDate}T06:40:00Z`)
      || retrieved >= Date.parse(`${targetDate}T06:40:00Z`) || Math.abs(observed - retrieved) > 1000 || !isRecorded) { missing += 1; continue; }
    const actual = (row.actual_close / row.actual_open - 1) * 100;
    const expected = (row.expected_close / row.expected_open - 1) * 100;
    sum += Math.abs(actual - expected); compared += 1;
  }
  const status = compared && !missing && step.status === "ready" ? "ready" : compared ? "partial" : "blocked";
  return { status, targetDate, compared, missing, excluded, forecastExcluded, meanAbsoluteError: compared ? sum / compared : null,
    message: `${targetDate} 정산 비교 ${compared}개, 미확인 ${missing}개, 거래 없음 ${excluded}개, 장전 예측 제외 후 거래 ${forecastExcluded}개. 출처: ${source.name || "네이버 공개 시세"}; 기준과 이용 조건은 원본 기록을 따릅니다.` };
}
