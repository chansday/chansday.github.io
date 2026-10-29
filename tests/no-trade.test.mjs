import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNaverCrawlProvider, isHaltedQuote } from "../providers/naver-crawl-provider.js";
import { loadNaverDailyHistory, priorTradingDates } from "../providers/naver-daily-cache.js";
import { validateRankingRows } from "../providers/provider-adapter.js";
import { buildEvaluationSummary } from "../providers/evaluation-contract.js";
import { NO_TRADE_LABEL, buildSelectedDetail } from "../providers/selected-detail.js";
import { mergeRows } from "../scripts/update-results.mjs";
import { buildCatchUpSnapshot, noTradeEvidence } from "../scripts/close-catch-up.mjs";

// Halted symbols: only the source's own halt marker (polling tradeStopType /
// tradableStatus) or a daily candle with volume 0 is no_trade; missing values
// alone stay missing (partial). Field values copied from a real quote observed
// 2026-10-29 09:08 KST (000300 halted, 005930 trading).
const json = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(payload) });
const text = (body, status = 200, type = "text/plain") => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": type }), text: async () => body });
const quote = (symbol, extra = {}) => ({ symbolCode: symbol, stockName: symbol, openPriceRaw: "100", closePriceRaw: "110", accumulatedTradingVolumeRaw: "5000", localTradedAt: "2026-10-27T10:00:00+09:00", marketStatus: "OPEN", stockExchangeType: { code: "KS" }, ...extra });
const routes = (symbols, quotes) => async (url) => {
  const u = new URL(url), key = `${u.origin}${u.pathname}`;
  if (key === "https://api.stock.naver.com/robots.txt" || key === "https://polling.finance.naver.com/robots.txt") return text("{}", 404, "application/json");
  if (key === "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue") return json({ totalCount: symbols.length, stocks: symbols.map((itemCode) => ({ itemCode, stockName: itemCode })) });
  if (key.startsWith("https://polling.finance.naver.com/api/realtime/domestic/stock/")) return json({ datas: quotes });
  throw new Error(`unexpected request ${url}`);
};
const env = { KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0", KOSPI_UNIVERSE_CACHE: "tests/__missing__.json", KOSPI_DAILY_HISTORY: "naver-cache" };
const A = "005930", H = "000300", N = "001470";
const TRADING = { tradeStopType: { code: "1", text: "운영.Trading", name: "TRADING" }, tradableStatus: "tradable", tradableStatusCode: "ok" };
const HALTED = { tradeStopType: { code: "2", text: "정지.Halted", name: "HALTED" }, tradableStatus: "halt", tradableStatusCode: "eventHalt01", tradableStatusUpdatedAt: "2026-10-29T08:01:39.95+09:00",
  openPriceRaw: "", highPriceRaw: "", lowPriceRaw: "", accumulatedTradingVolumeRaw: "", closePriceRaw: "4200", compareToPreviousClosePriceRaw: "0", marketStatus: "OPEN" };
const NULLS = { ...TRADING, openPriceRaw: "", highPriceRaw: "", lowPriceRaw: "", accumulatedTradingVolumeRaw: "" };

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "no-trade-")); const before = process.env.KOSPI_DATA_ROOT; process.env.KOSPI_DATA_ROOT = root;
  try { return await fn(root); } finally { if (before === undefined) delete process.env.KOSPI_DATA_ROOT; else process.env.KOSPI_DATA_ROOT = before; await rm(root, { recursive: true, force: true }); }
}
async function settle(method, at, quotes) {
  const time = new Date(at);
  return createNaverCrawlProvider({ env, fetchImpl: routes(quotes.map((q) => q.symbolCode), quotes), now: () => time, runStartedAt: time.toISOString() })[method]();
}

test("only the source halt marker makes a quote no_trade; missing or zero prices alone do not", () => {
  assert.equal(isHaltedQuote({ tradeStopType: "HALTED" }), true);
  assert.equal(isHaltedQuote({ tradableStatus: "halt" }), true);
  for (const q of [{ tradeStopType: "TRADING", tradableStatus: "tradable" }, { openPrice: 0, volume: 0 }, { openPrice: null, volume: null }, {}]) assert.equal(isHaltedQuote(q), false);
});

test("open-settlement: a HALTED quote (empty open/volume) is no_trade and keeps the stage ready; null quotes stay partial", async () => withRoot(async () => {
  const at = "2026-10-27T01:00:00Z";
  const ready = await settle("settleOpen", at, [quote(A, TRADING), quote(H, HALTED)]);
  assert.equal(ready.status, "ready");
  const h = ready.rows.find((r) => r.symbol === H);
  assert.equal(h.trading_status, "no_trade_observed");
  assert.deepEqual(h.no_trade_evidence, { source: "naver_polling_quote", trade_stop_type: "HALTED", tradable_status: "halt", tradable_status_code: "eventHalt01", observed_at: "2026-10-27T01:00:00.000Z", reason: h.no_trade_evidence.reason });
  assert.deepEqual([h.actual_open, h.actual_close, h.actual_volume, h.error], [null, null, null, null]);
  assert.equal(ready.source.metrics.no_trade_count, 1); assert.match(ready.message, /1 symbol\(s\) are no_trade_observed/);
  assert.equal(validateRankingRows(ready.rows, { koreanSymbols: true }).valid, true);
  const partial = await settle("settleOpen", at, [quote(A), quote(H, HALTED), quote(N, NULLS)]);
  assert.equal(partial.status, "partial"); assert.equal(partial.rows.find((r) => r.symbol === N).trading_status, undefined);
  assert.equal((await settle("settleOpen", at, [quote(A), quote(N, { ...TRADING, openPriceRaw: "0", accumulatedTradingVolumeRaw: "0" })])).status, "partial", "zeros without the halt marker are not enough");
}));

test("close-settlement: HALTED quotes are no_trade and ready; unmarked missing prices stay partial", async () => withRoot(async () => {
  const at = "2026-10-27T06:40:00Z", closed = { localTradedAt: "2026-10-27T15:35:00+09:00", marketStatus: "CLOSE" };
  const ready = await settle("settleClose", at, [quote(A, closed), quote(H, { ...closed, ...HALTED })]);
  assert.equal(ready.status, "ready"); assert.equal(ready.rows.find((r) => r.symbol === H).trading_status, "no_trade_observed");
  assert.equal(ready.rows.find((r) => r.symbol === A).actual_close, 110);
  assert.equal((await settle("settleClose", at, [quote(A, closed), quote(H, { ...closed, ...TRADING, openPriceRaw: "", accumulatedTradingVolumeRaw: "" })])).status, "partial", "empty prices without the halt marker stay partial");
  assert.equal((await settle("settleClose", at, [quote(A, closed), quote(N, { ...closed, ...NULLS })])).status, "partial");
  // Halted after trading (volume > 0): observed prices are settled, not no_trade.
  const tradedThenHalted = await settle("settleClose", at, [quote(A, closed), quote(H, { ...closed, ...HALTED, openPriceRaw: "4100", closePriceRaw: "4200", accumulatedTradingVolumeRaw: "1200" })]);
  assert.equal(tradedThenHalted.status, "ready");
  const th = tradedThenHalted.rows.find((r) => r.symbol === H);
  assert.equal(th.trading_status, undefined); assert.deepEqual([th.actual_open, th.actual_close], [4100, 4200]);
}));

function cacheRecord(targetDate, dates, symbols, rejected, rowsFor) {
  const day = new Date(`${targetDate}T00:00:00+09:00`).getTime();
  return { schema_version: 1, source: "naver-daily", target_date: targetDate, started_at: new Date(day + 6 * 3600e3).toISOString(), retrieved_at: new Date(day + 6.5 * 3600e3).toISOString(), license_status: "unconfirmed", symbols,
    sessions: dates.map((date) => ({ date, rows: rowsFor(date).map((symbol) => ({ symbol, date, open: 100, high: 112, low: 98, close: 110, volume: 1000 })) })), rejected };
}

test("history: symbols excluded only by zero-volume sessions are no_trade, other exclusions keep the cache partial", async () => withRoot(async (root) => {
  const target = "2026-10-27", dates = await priorTradingDates(target);
  await mkdir(join(root, "data", "daily-history"), { recursive: true });
  const write = (rejected) => writeFile(join(root, "data", "daily-history", `${target}.json`), JSON.stringify(cacheRecord(target, dates, [A, H], rejected, () => [A])));
  const now = () => new Date("2026-10-26T23:20:00Z");
  await write(dates.map((date) => ({ symbol: H, date, reason: "zero_volume" })));
  const halted = await loadNaverDailyHistory({ targetDate: target, now });
  assert.equal(halted.ok, true); assert.equal(halted.partial, false); assert.equal(halted.no_trade_count, 1);
  assert.deepEqual(halted.no_trade_symbols, [{ symbol: H, dates }]);
  await write([{ symbol: H, date: dates[0], reason: "zero_volume" }, { symbol: H, date: dates[1], reason: "invalid_ohlcv" }, { symbol: H, date: dates[2], reason: "zero_volume" }]);
  const mixed = await loadNaverDailyHistory({ targetDate: target, now });
  assert.equal(mixed.partial, true); assert.equal(mixed.no_trade_count, 0);

  // forecast stage: the zero-volume symbol keeps expected_open null with an explicit marker; stage ready.
  await write(dates.map((date) => ({ symbol: H, date, reason: "zero_volume" })));
  const pre = { localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN" };
  const forecast = await settle("generateForecast", "2026-10-26T23:20:00Z", [quote(A, pre), quote(H, { ...pre, ...TRADING, openPriceRaw: "", accumulatedTradingVolumeRaw: "" })]);
  assert.equal(forecast.status, "ready", forecast.message);
  const h = forecast.rows.find((r) => r.symbol === H);
  assert.equal(h.expected_open, null); assert.equal(h.trading_status, "no_trade_observed"); assert.equal(h.no_trade_evidence.source, "naver_daily_history");
  assert.equal(forecast.source.metrics.no_trade_count, 1);
  await write([{ symbol: H, date: dates[0], reason: "invalid_ohlcv" }]);
  const notHalted = await settle("generateForecast", "2026-10-26T23:20:00Z", [quote(A, pre), quote(H, { ...pre, ...TRADING, openPriceRaw: "", accumulatedTradingVolumeRaw: "" })]);
  assert.equal(notHalted.status, "partial", "an exclusion without zero-volume evidence is still partial");
  // A HALTED marker on the forecast quote is no_trade even when history is also missing.
  const marked = await settle("generateForecast", "2026-10-26T23:20:00Z", [quote(A, pre), quote(H, { ...HALTED, ...pre })]);
  assert.equal(marked.status, "ready", marked.message);
  const hm = marked.rows.find((r) => r.symbol === H);
  assert.equal(hm.expected_open, null); assert.equal(hm.no_trade_evidence.source, "naver_polling_quote"); assert.equal(hm.no_trade_evidence.trade_stop_type, "HALTED");
}));

const baseRow = (symbol, extra = {}) => ({ rank: 1, symbol, name: symbol, expected_open: null, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, session_return: null, actual_volume: null, error: null, status: "valid", ...extra });
const pollingEvidence = { source: "naver_polling_quote", trade_stop_type: "HALTED", tradable_status: "halt", tradable_status_code: "eventHalt01", observed_at: "2026-10-28T00:10:00.000Z", reason: "halted" };

test("row validation: the marker requires source zero evidence and no observed prices", () => {
  const ok = baseRow(H, { trading_status: "no_trade_observed", no_trade_evidence: pollingEvidence });
  assert.equal(validateRankingRows([ok]).valid, true);
  for (const bad of [{ ...ok, actual_open: 100 }, { ...ok, no_trade_evidence: { ...pollingEvidence, trade_stop_type: "TRADING", tradable_status: "tradable" } }, { ...ok, no_trade_evidence: { ...pollingEvidence, observed_at: null } }, { ...ok, no_trade_evidence: { source: "naver_daily_candle", volume: null, dates: ["2026-10-28"], reason: "x" } }, { ...ok, trading_status: "halted" }, { ...baseRow(H), no_trade_evidence: pollingEvidence },
    { ...ok, no_trade_evidence: { source: "naver_daily_history", volume: 0, dates: ["2026-10-27"], reason: "x" }, expected_open: 100 }]) assert.equal(validateRankingRows([bad]).valid, false);
});

test("merge: the marker follows the incoming settlement row", () => {
  const halted = baseRow(H, { trading_status: "no_trade_observed", no_trade_evidence: pollingEvidence });
  assert.equal(mergeRows([baseRow(H, { actual_open: 100 })], [halted], "close-settlement")[0].trading_status, "no_trade_observed");
  assert.equal(mergeRows([baseRow(H, { actual_open: 100 })], [halted], "close-settlement")[0].actual_open, null);
  const traded = mergeRows([halted], [baseRow(H, { actual_open: 100, actual_close: 110, session_return: 10 })], "close-settlement")[0];
  assert.equal(traded.trading_status, undefined); assert.equal(traded.no_trade_evidence, undefined);
});

test("evaluation excludes no_trade rows from samples", () => {
  const rows = [baseRow(A, { expected_open: 100, expected_close: 110, expected_return: 10, actual_open: 100, actual_close: 105, session_return: 5, error: -5 }), baseRow(H, { trading_status: "no_trade_observed", no_trade_evidence: pollingEvidence })];
  const summary = buildEvaluationSummary(rows);
  assert.equal(summary.sample_count, 1); assert.equal(summary.evaluated_sample_count, 1); assert.equal(summary.status, "evaluated");
});

test("catch-up: zero-volume candle or a same-date halt marker is no_trade; a missing candle without evidence stays partial", () => {
  const D = "2026-10-28";
  const base = { label: "0900", snapshot: { rows: [baseRow(A), baseRow(H), baseRow(N)], meta: { run_id: "b" }, pipeline: {} } };
  const candles = new Map([[A, { symbol: A, date: D, open: 101, high: 106, low: 100, close: 105, volume: 10 }]]);
  const args = { runDate: D, base, candles, producedAt: "2026-10-29T00:40:00.000Z", runId: "c.1", candleSource: "cache" };
  const partial = buildCatchUpSnapshot({ ...args, zeroVolume: new Set([H]) });
  assert.equal(partial.status, "partial", "N has no candle and no zero evidence");
  assert.equal(partial.meta.catch_up.no_trade_count, 1);
  const ready = buildCatchUpSnapshot({ ...args, base: { ...base, snapshot: { ...base.snapshot, rows: [baseRow(A), baseRow(H)] } }, zeroVolume: new Set([H]) });
  assert.equal(ready.status, "ready"); const h = ready.rows.find((r) => r.symbol === H);
  assert.deepEqual(h.no_trade_evidence, { source: "naver_daily_candle", volume: 0, dates: [D], reason: h.no_trade_evidence.reason });
  assert.match(ready.pipeline.closeSettlement.message, /1 symbol\(s\) are no_trade_observed/);
  assert.deepEqual(noTradeEvidence(baseRow(H, { trading_status: "no_trade_observed", no_trade_evidence: pollingEvidence }), D), pollingEvidence);
  assert.equal(noTradeEvidence(baseRow(H, { actual_open: 0, actual_volume: 0, quote_at: "2026-10-28T00:10:00.000Z" }), D), null, "stored zeros without the marker are not evidence");
  assert.equal(noTradeEvidence(baseRow(H), D), null, "null values are not evidence");
  assert.equal(noTradeEvidence(baseRow(H, { trading_status: "no_trade_observed", no_trade_evidence: { ...pollingEvidence, observed_at: "2026-10-27T00:10:00.000Z" } }), D), null, "evidence from another date does not count");
});

test("detail panel says 거래 없음(정지 추정) instead of missing-data notes for no_trade rows", () => {
  const detail = buildSelectedDetail(baseRow(H, { trading_status: "no_trade_observed", no_trade_evidence: pollingEvidence }), { pipeline: { openSettlement: { status: "ready" }, closeSettlement: { status: "ready" } } });
  const actual = detail.sections.find((s) => s.id === "actual");
  assert.equal(actual.state, "no_trade"); assert.deepEqual(actual.missing, []);
  assert.ok(actual.sentences.some((s) => s.startsWith(NO_TRADE_LABEL)));
  assert.ok(detail.sections.every((s) => s.missing.length === 0));
  const normal = buildSelectedDetail(baseRow(N), {});
  assert.ok(normal.sections.find((s) => s.id === "actual").missing.length > 0, "ordinary missing rows keep their notes");
});
