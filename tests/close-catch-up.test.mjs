import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarketCalendar } from "../scripts/market-calendar.mjs";
import { CATCH_UP_SOURCE, buildCatchUpSnapshot, catchUpDate, catchUpEligibility, loadCatchUpBase, missingCloseSettlementDates, runCatchUp } from "../scripts/close-catch-up.mjs";
import { validateRankingRows } from "../providers/provider-adapter.js";
import { naverRobotsFetch } from "./naver-robots-helper.mjs";

// No network: candles come from fixture cache files or a mocked fetch.
const calendar = await loadMarketCalendar();
const D = "2026-10-28", T = "2026-10-29";
const NOW = () => new Date("2026-10-29T00:40:00.000Z"); // 09:40 KST on T
const noNetwork = async (url) => { throw new Error(`unexpected request ${url}`); };
const A = "005930", B = "000660";

function row(symbol, extra = {}) {
  return { rank: 1, symbol, name: `n${symbol}`, expected_open: null, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, session_return: null, actual_volume: 10, prior_close: 100, error: null, confidence: null, quality: "naver_live_quote", status: "valid", quote_at: "2026-10-28T00:10:00.000Z", quote_age_seconds: 1, market_status: "OPEN", ...extra };
}
function stage(stageName, rows, runDate = D) {
  return { schemaVersion: "1.0.0", status: "ready", mode: "provider", asOfDate: runDate, publishedAt: "2026-10-28T00:10:00.000Z", market: { name: "KOSPI", currency: "KRW", timezone: "Asia/Seoul" },
    provider: { id: "naver-crawl", status: "ready", label: "NAVER", source: null },
    pipeline: { previousResult: { status: "pending" }, analysis: { status: "pending" }, forecast: { status: "ready" }, openSettlement: { status: stageName === "open-settlement" ? "ready" : "pending" }, closeSettlement: { status: "pending", attemptedAt: null, provider_id: null, message: null } },
    rows, meta: { generatedBy: "provider-adapter", run_date: runDate, run_stage: stageName, run_id: "base-run.1", source: { source_date: runDate } } };
}
const ohlc = (symbol, date, open, close) => ({ symbol, date, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 });
function cache(targetDate, dates, symbols, price) {
  const day = new Date(`${targetDate}T00:00:00+09:00`).getTime();
  return { schema_version: 1, source: "naver-daily", target_date: targetDate, started_at: new Date(day + 6 * 3600e3).toISOString(), retrieved_at: new Date(day + 6.5 * 3600e3).toISOString(), license_status: "unconfirmed", symbols,
    sessions: dates.map((date) => ({ date, rows: symbols.map((s) => ohlc(s, date, ...price(s, date))) })), robots_url: "https://api.stock.naver.com/robots.txt", robots_status: 404, robots_checked_at: new Date(day + 6 * 3600e3).toISOString() };
}
const price = (s, date) => (date === D ? (s === A ? [101, 105] : [205, 200]) : [100, 102]);

async function setup({ base = true, tCache = true, dCache = true, latest = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "catch-up-"));
  process.env.KOSPI_DATA_ROOT = root;
  await mkdir(join(root, "data", "runs", D), { recursive: true });
  await mkdir(join(root, "data", "daily-history"), { recursive: true });
  // A: valid pre-open quote recorded 08:50 KST on D. B: intraday baseline without
  // a source in 0900 (stripped) but a valid pre-open history opening in 0820.
  const a0900 = row(A, { expected_open: 100, expected_close: 104, expected_return: 4, expected_open_source: { kind: "preopen_quote", recorded_at: "2026-10-27T23:50:00.000Z", history_dates: [] }, actual_open: 101 });
  const b0900 = row(B, { rank: 2, expected_open: 200, actual_open: 205 });
  const b0820 = row(B, { rank: 2, expected_open: 210, expected_open_source: { kind: "preopen_history", recorded_at: "2026-10-27T23:10:00.000Z", history_dates: ["2026-10-27", "2026-10-26", "2026-10-23"] } });
  if (base) {
    await writeFile(join(root, "data", "runs", D, "0900.json"), JSON.stringify(stage("open-settlement", [a0900, b0900])));
    await writeFile(join(root, "data", "runs", D, "0820.json"), JSON.stringify(stage("forecast", [row(A), b0820])));
  }
  if (tCache) await writeFile(join(root, "data", "daily-history", `${T}.json`), JSON.stringify(cache(T, ["2026-10-28", "2026-10-27", "2026-10-26"], [A, B], price)));
  if (dCache) await writeFile(join(root, "data", "daily-history", `${D}.json`), JSON.stringify(cache(D, ["2026-10-27", "2026-10-26", "2026-10-23"], [A, B], price)));
  if (latest) await writeFile(join(root, "data", "latest-snapshot.json"), JSON.stringify(latest));
  return root;
}
async function cleanup(root) { delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("eligibility: only past KOSPI trading days within the previous five trading days", () => {
  assert.deepEqual(catchUpEligibility(D, T, calendar), { eligible: true, reason: null });
  assert.equal(catchUpEligibility(T, T, calendar).reason, "not_a_past_date");
  assert.equal(catchUpEligibility("2026-10-30", T, calendar).reason, "not_a_past_date");
  assert.equal(catchUpEligibility("2026-10-25", T, calendar).reason, "not_a_trading_day");
  assert.equal(catchUpEligibility("2026-10-22", T, calendar).eligible, true);
  assert.match(catchUpEligibility("2026-10-21", T, calendar).reason, /older_than_5_trading_days/);
});

test("builds a ready 1530 from cached candles, carries the recorded forecast bundle, evaluates and indexes without touching other files", async () => {
  const newerLatest = stage("forecast", [row(A)], T);
  const root = await setup({ latest: newerLatest });
  try {
    const before0900 = await readFile(join(root, "data", "runs", D, "0900.json"), "utf8");
    assert.deepEqual(await missingCloseSettlementDates({ today: T, calendar }), [D]);
    const outcome = await runCatchUp({ now: NOW, calendar, runId: "catch.1", fetchImpl: noNetwork });
    assert.equal(outcome.status, "ready"); assert.equal(outcome.retrospective, "ready");
    const [result] = outcome.results;
    assert.equal(result.candleSource, "cache"); assert.equal(result.priorHistory, "cache");
    const settled = await readJson(join(root, "data", "runs", D, "1530.json"));
    assert.equal(settled.status, "ready"); assert.equal(settled.asOfDate, D);
    assert.equal(settled.meta.run_stage, "close-settlement"); assert.equal(settled.meta.run_date, D); assert.equal(settled.meta.run_id, "catch.1");
    assert.equal(settled.meta.settlement_source, CATCH_UP_SOURCE); assert.equal(settled.meta.catch_up.base_stage, "0900"); assert.equal(settled.meta.catch_up.produced_kst_date, T);
    assert.equal(settled.meta.source.source_date, D); assert.equal(settled.meta.source.url, "https://api.stock.naver.com/chart/domestic/item/");
    assert.match(settled.meta.source_warning, /NXT after-hours/); assert.match(settled.pipeline.closeSettlement.message, /NXT after-hours/);
    assert.equal(validateRankingRows(settled.rows, { koreanSymbols: true }).valid, true);
    const a = settled.rows.find((r) => r.symbol === A), b = settled.rows.find((r) => r.symbol === B);
    assert.deepEqual([a.actual_open, a.actual_close, a.session_return, a.expected_open, a.expected_return, a.error], [101, 105, 3.96, 100, 4, -0.04]);
    assert.deepEqual(a.expected_open_source, { kind: "preopen_quote", recorded_at: "2026-10-27T23:50:00.000Z", history_dates: [] });
    assert.equal(b.expected_open, 210, "valid pre-open opening recovered from 0820"); assert.equal(b.expected_open_source.kind, "preopen_history");
    assert.deepEqual([b.actual_open, b.actual_close], [205, 200]);
    assert.equal(a.quality, "naver_daily_candle_catch_up"); assert.equal(a.quote_at, null);
    assert.deepEqual(settled.rows.map((r) => r.rank), [1, 2]);
    const retro = await readJson(join(root, "data", "runs", D, "retrospective-catch.1.json"));
    assert.equal(retro.run_id, "catch.1"); assert.deepEqual(retro.history_dates, ["2026-10-27", "2026-10-26", "2026-10-23"]);
    assert.ok(retro.evaluation.evaluated_sample_count > 0);
    const index = await readJson(join(root, "data", "date-index.json"));
    assert.deepEqual(index.availableDates.provider, [D]);
    assert.deepEqual(await readJson(join(root, "data", "latest-snapshot.json")), newerLatest, "a newer latest snapshot is not regressed");
    assert.equal(await readFile(join(root, "data", "runs", D, "0900.json"), "utf8"), before0900);
    assert.deepEqual((await readdir(join(root, "data", "runs", D))).sort(), ["0820.json", "0900.json", "1530.json", "retrospective-catch.1.json"]);
    // A second run finds nothing to do and never rewrites the settlement.
    const content = await readFile(join(root, "data", "runs", D, "1530.json"), "utf8");
    assert.equal((await runCatchUp({ now: NOW, calendar, runId: "catch.2", fetchImpl: noNetwork })).status, "not_needed");
    const again = await runCatchUp({ dates: [D], now: NOW, calendar, runId: "catch.3", fetchImpl: noNetwork });
    assert.equal(again.results[0].status, "not_needed"); assert.equal(again.status, "not_needed");
    assert.equal(await readFile(join(root, "data", "runs", D, "1530.json"), "utf8"), content);
  } finally { await cleanup(root); }
});

test("never overwrites an existing 1530.json", async () => {
  const root = await setup();
  try {
    const path = join(root, "data", "runs", D, "1530.json");
    await writeFile(path, "{\"status\":\"partial\"}\n");
    const result = await catchUpDate({ runDate: D, today: T, calendar, now: NOW, runId: "catch.1", fetchImpl: noNetwork });
    assert.equal(result.status, "not_needed"); assert.deepEqual(result.wrote, []);
    assert.equal(await readFile(path, "utf8"), "{\"status\":\"partial\"}\n");
  } finally { await cleanup(root); }
});

test("updates the latest snapshot only while it still shows the same date before close", async () => {
  const root = await setup({ latest: stage("open-settlement", [row(A)]) });
  try {
    const result = await catchUpDate({ runDate: D, today: T, calendar, now: NOW, runId: "catch.1", fetchImpl: noNetwork });
    assert.ok(result.wrote.includes("data/latest-snapshot.json"));
    const latest = await readJson(join(root, "data", "latest-snapshot.json"));
    assert.equal(latest.meta.run_stage, "close-settlement"); assert.equal(latest.meta.settlement_source, CATCH_UP_SOURCE);
  } finally { await cleanup(root); }
});

test("no same-date forecast/open file: no_data and nothing written", async () => {
  const root = await setup({ base: false });
  try {
    assert.deepEqual(await missingCloseSettlementDates({ today: T, calendar }), []);
    const result = await catchUpDate({ runDate: D, today: T, calendar, now: NOW, runId: "catch.1", fetchImpl: noNetwork });
    assert.equal(result.status, "no_data"); assert.deepEqual(result.wrote, []);
    assert.deepEqual(await readdir(join(root, "data", "runs", D)), []);
    const explicit = await runCatchUp({ dates: [D], now: NOW, calendar, runId: "catch.1", fetchImpl: noNetwork });
    assert.equal(explicit.status, "no_data");
  } finally { await cleanup(root); }
});

test("a wrong-date or test-only base file is not settled", async () => {
  const root = await setup({ base: false });
  try {
    await writeFile(join(root, "data", "runs", D, "0900.json"), JSON.stringify({ ...stage("open-settlement", [row(A)]), asOfDate: "2026-10-27" }));
    await writeFile(join(root, "data", "runs", D, "0820.json"), JSON.stringify({ ...stage("forecast", [row(A)]), meta: { ...stage("forecast", []).meta, test_only: true } }));
    assert.equal(await loadCatchUpBase(D), null);
  } finally { await cleanup(root); }
});

test("robots denial on the chart host blocks the catch-up before any chart request", async () => {
  const root = await setup({ tCache: false, dCache: false });
  const requested = [];
  try {
    const fetchImpl = async (url) => {
      requested.push(String(url));
      if (String(url) === "https://api.stock.naver.com/robots.txt") return { ok: true, status: 200, headers: new Headers({ "content-type": "text/plain" }), text: async () => "User-agent: *\nDisallow: /\n" };
      throw new Error(`unexpected request ${url}`);
    };
    const result = await catchUpDate({ runDate: D, today: T, calendar, now: NOW, runId: "catch.1", fetchImpl, sleep: async () => {} });
    assert.equal(result.status, "blocked"); assert.equal(result.fetchStatus, "blocked"); assert.deepEqual(result.wrote, []);
    assert.deepEqual(requested, ["https://api.stock.naver.com/robots.txt"]);
    await assert.rejects(readFile(join(root, "data", "runs", D, "1530.json")), { code: "ENOENT" });
  } finally { await cleanup(root); }
});

test("without cached candles, the robots-gated chart response settles D and supplies the prior history", async () => {
  const root = await setup({ tCache: false, dCache: false });
  const urls = [];
  try {
    const dates = ["2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"];
    const fetchImpl = naverRobotsFetch(async (url, init) => {
      urls.push([String(url), init.headers["User-Agent"]]);
      const symbol = String(url).match(/item\/(\d{6})\/day/)[1];
      const body = dates.map((date) => { const [o, c] = price(symbol, date); return { localDate: date.replaceAll("-", ""), openPrice: o, closePrice: c, highPrice: Math.max(o, c) + 1, lowPrice: Math.min(o, c) - 1, accumulatedTradingVolume: 1000 }; });
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(body) };
    });
    const outcome = await runCatchUp({ dates: [D], now: NOW, calendar, runId: "catch.1", fetchImpl, sleep: async () => {} });
    assert.equal(outcome.status, "ready"); assert.equal(outcome.retrospective, "ready");
    assert.equal(outcome.results[0].candleSource, "chart_request"); assert.equal(outcome.results[0].priorHistory, "chart_request");
    assert.equal(urls.length, 2);
    for (const [url, agent] of urls) {
      assert.match(url, /^https:\/\/api\.stock\.naver\.com\/chart\/domestic\/item\/\d{6}\/day\?startDateTime=202610080000&endDateTime=202610282359$/);
      assert.equal(agent, "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)");
    }
    const settled = await readJson(join(root, "data", "runs", D, "1530.json"));
    assert.equal(settled.meta.catch_up.candle_source, "chart_request"); assert.equal(settled.meta.source.metrics.robots_status, 404);
  } finally { await cleanup(root); }
});

test("a cached D candle settles a symbol even when the cache lacks one of its older sessions", async () => {
  const root = await setup();
  try {
    const path = join(root, "data", "daily-history", `${T}.json`);
    const record = await readJson(path);
    record.sessions[2].rows = record.sessions[2].rows.filter((r) => r.symbol !== B); // B misses 2026-10-26
    await writeFile(path, JSON.stringify(record));
    const result = await catchUpDate({ runDate: D, today: T, calendar, now: NOW, runId: "catch.1", fetchImpl: noNetwork });
    assert.equal(result.status, "ready"); assert.equal(result.candleSource, "cache"); assert.equal(result.settled, 2);
  } finally { await cleanup(root); }
});

test("missing candles leave a partial result that is not written", () => {
  const base = { label: "0900", snapshot: stage("open-settlement", [row(A), row(B, { rank: 2 })]) };
  const candles = new Map([[A, ohlc(A, D, 101, 105)]]);
  const snapshot = buildCatchUpSnapshot({ runDate: D, base, candles, producedAt: NOW().toISOString(), runId: "catch.1", candleSource: "cache" });
  assert.equal(snapshot.status, "partial"); assert.equal(snapshot.publishedAt, null);
  assert.equal(snapshot.rows.find((r) => r.symbol === B).quality, "naver_daily_candle_missing");
  assert.equal(buildCatchUpSnapshot({ runDate: D, base, candles: new Map(), producedAt: NOW().toISOString(), runId: "catch.1", candleSource: "none" }).status, "no_data");
  assert.equal(buildCatchUpSnapshot({ runDate: D, base, candles, producedAt: NOW().toISOString(), runId: "catch.1", candleSource: "cache", fetchStatus: "blocked" }).status, "blocked");
});
