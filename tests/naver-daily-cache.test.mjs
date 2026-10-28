import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNaverDailyHistory, priorTradingDates } from "../providers/naver-daily-cache.js";
import { createNaverCrawlProvider, historicalOpenEstimate } from "../providers/naver-crawl-provider.js";
import { collectDaily } from "../scripts/collect-naver-daily.mjs";
import { run } from "../scripts/update-results.mjs";
import { noDataSnapshot } from "../providers/provider-adapter.js";
import { naverRobotsFetch, withNaverRobots } from "./naver-robots-helper.mjs";

test("cache requires exact previous sessions and excludes symbols missing any session", async () => {
  const root = await mkdtemp(join(tmpdir(), "naver-daily-"));
  const path = join(root, "cache.json"), dates = await priorTradingDates("2026-10-27");
  const row = symbol => ({ symbol, open: 100, high: 120, low: 90, close: 110, volume: 100 });
  const record = { schema_version: 1, source: "naver-daily", target_date: "2026-10-27", started_at: "2026-10-26T22:40:00Z", retrieved_at: "2026-10-26T22:55:00Z", license_status: "unconfirmed", symbols: ["005930", "000660"], sessions: dates.map((date, i) => ({ date, rows: (i ? [row("005930")] : [row("005930"), row("000660")]).map(r => ({ ...r, date })) })) };
  try {
    await writeFile(path, JSON.stringify(record));
    const history = await loadNaverDailyHistory({ targetDate: record.target_date, path, now: () => new Date("2026-10-26T23:20:00Z") });
    assert.equal(history.ok, true); assert.equal(history.partial, true); assert.equal(history.excluded_count, 1);
    assert.ok(history.sessions.every(s => s.rows.length === 1)); assert.ok(historicalOpenEstimate(history.sessions, "005930") > 0); assert.equal(historicalOpenEstimate(history.sessions, "000660"), null);
    record.sessions[1].date = "2026-10-20"; await writeFile(path, JSON.stringify(record));
    assert.equal((await loadNaverDailyHistory({ targetDate: record.target_date, path, now: () => new Date("2026-10-26T23:20:00Z") })).ok, false);
    record.sessions[1].date = dates[1]; record.retrieved_at = "2026-10-26T23:00:00Z"; await writeFile(path, JSON.stringify(record));
    assert.equal((await loadNaverDailyHistory({ targetDate: record.target_date, path, now: () => new Date("2026-10-26T23:20:00Z") })).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("collector saves partial exact-session coverage once and rejects late start", async () => {
  const root = await mkdtemp(join(tmpdir(), "naver-collect-")), old = process.cwd();
  const dates = await priorTradingDates("2026-10-27");
  const rows = dates.map(date => ({ symbol: "005930", date, open: 100, high: 120, low: 90, close: 110, volume: 100 }));
  try {
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const now = () => new Date("2026-10-26T22:50:00Z");
    const universeFetcher = async () => ({ ok: true, symbols: [{ symbol: "005930" }, { symbol: "000660" }] });
    const collector = async () => ({ status: "partial", observations: rows, rejected: [{ symbol: "000660", reason: "conflict" }], requested: 2, elapsed_ms: 500, durations_ms: [5, 5] });
    const result = await collectDaily({ now, universeFetcher, collector, sleep: async () => {} });
    assert.equal(result.status, "partial"); assert.equal(result.excluded, 1);
    const content = await readFile(result.path, "utf8");
    assert.equal((await collectDaily({ now, universeFetcher, collector, sleep: async () => {} })).status, "preserved"); assert.equal(await readFile(result.path, "utf8"), content);
    await assert.rejects(collectDaily({ now, universeFetcher, collector: async () => ({ status: "blocked", reason: "rate_limited", requested: 1 }), sleep: async () => {} }), /rate_limited/);
    assert.equal(await readFile(result.path, "utf8"), content);
    const improvedRows = [...rows, ...dates.map(date => ({ symbol: "000660", date, open: 100, high: 120, low: 90, close: 110, volume: 100 }))];
    const changedRows = improvedRows.map((r, i) => i === 0 ? { ...r, close: 111 } : r);
    await assert.rejects(collectDaily({ now, universeFetcher, collector: async () => ({ status: "ready", observations: changedRows, rejected: [], requested: 2, elapsed_ms: 500, durations_ms: [5, 5] }), sleep: async () => {} }), /Previously valid history changed/);
    assert.equal(await readFile(result.path, "utf8"), content);
    const improved = await collectDaily({ now, universeFetcher, collector: async () => ({ status: "ready", observations: improvedRows, rejected: [], requested: 2, elapsed_ms: 500, durations_ms: [5, 5] }), sleep: async () => {} });
    assert.equal(improved.status, "ready"); assert.equal(improved.excluded, 0);
    assert.equal((await loadNaverDailyHistory({ targetDate: "2026-10-27", now })).partial, false);
    const improvedContent = await readFile(result.path, "utf8");
    assert.equal((await collectDaily({ now, universeFetcher, collector: async () => { throw new Error("must not request"); } })).status, "preserved");
    assert.equal(await readFile(result.path, "utf8"), improvedContent);
    await writeFile(result.path, "{broken");
    await assert.rejects(collectDaily({ now, universeFetcher, collector, sleep: async () => {} }), /invalid and was preserved/);
    assert.equal(await readFile(result.path, "utf8"), "{broken");
    await assert.rejects(collectDaily({ now: () => new Date("2026-10-26T23:00:00Z"), universeFetcher, collector }), /before 08:00/);
  } finally { process.chdir(old); delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
});

test("a concurrent collection cannot replace the same cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "naver-lock-")), old = process.cwd();
  try {
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root; const now = () => new Date("2026-10-26T22:50:00Z");
    let signal, release; const started = new Promise(r => { signal = r; }); const hold = new Promise(r => { release = r; });
    const first = collectDaily({ now, universeFetcher: async () => { signal(); await hold; return { ok: false, reason: "test" }; } });
    await started; await assert.rejects(collectDaily({ now }), /lock exists/); release();
    await assert.rejects(first, /universe unavailable/);
  } finally { process.chdir(old); delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
});

test("preopen quote cannot hide a missing required Naver history cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "naver-no-cache-")), old = process.cwd();
  const now = new Date("2026-10-26T23:20:00Z");
  const respond = payload => ({ ok: true, status: 200, headers: { get: name => name === "content-type" ? "application/json" : null }, text: async () => JSON.stringify(payload) });
  try {
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const fetchImpl = async url => url.includes("marketValue") ? respond({ totalCount: 1, stocks: [{ itemCode: "005930" }] }) : respond({ datas: [{ symbolCode: "005930", openPriceRaw: 100, closePriceRaw: 100, localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN" }] });
    const result = await createNaverCrawlProvider(withNaverRobots({ env: { KOSPI_DAILY_HISTORY: "naver-cache", KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0" }, now: () => now, runStartedAt: now.toISOString(), fetchImpl })).generateForecast();
    assert.equal(result.status, "degraded"); assert.match(result.message, /history unavailable/i);
  } finally { process.chdir(old); delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
});

test("forecast uses dated cached close while settlement rejects pre-boundary quotes", async () => {
  const root = await mkdtemp(join(tmpdir(), "naver-stage-")), old = process.cwd();
  const target = "2026-10-27", dates = await priorTradingDates(target);
  const row = { symbol: "005930", open: 100, high: 120, low: 90, close: 110, volume: 100 };
  const cache = { schema_version: 1, source: "naver-daily", target_date: target, started_at: "2026-10-26T22:40:00Z", retrieved_at: "2026-10-26T22:55:00Z", license_status: "unconfirmed", symbols: ["005930"], sessions: dates.map(date => ({ date, rows: [{ ...row, date }] })) };
  try {
    await mkdir(join(root, "data", "daily-history"), { recursive: true }); await writeFile(join(root, "data", "daily-history", `${target}.json`), JSON.stringify(cache)); process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const respond = payload => ({ ok: true, status: 200, headers: { get: key => key === "content-type" ? "application/json" : null }, text: async () => JSON.stringify(payload) });
    const quote = { symbolCode: "005930", stockName: "A", openPriceRaw: 120, closePriceRaw: 130, compareToPreviousClosePriceRaw: "10", compareToPreviousPrice: { code: "2" }, localTradedAt: "2026-10-27T08:59:59+09:00", marketStatus: "OPEN" };
    const fetchImpl = async url => url.includes("marketValue") ? respond({ totalCount: 1, stocks: [{ itemCode: "005930", stockName: "A" }] }) : respond({ datas: [quote] });
    const env = { KOSPI_DAILY_HISTORY: "naver-cache", KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0" };
    const forecastTime = new Date("2026-10-26T23:20:00Z"); quote.localTradedAt = "2026-10-27T08:20:00+09:00";
    const forecast = await createNaverCrawlProvider(withNaverRobots({ env, fetchImpl, now: () => forecastTime, runStartedAt: forecastTime.toISOString() })).generateForecast();
    assert.equal(forecast.status, "ready"); assert.equal(forecast.rows[0].prior_close, 120); assert.equal(forecast.rows[0].expected_open_basis.inputs.prior_close, 110); assert.equal(forecast.rows[0].expected_open_source.kind, "preopen_history"); assert.equal(forecast.source.metrics.history_status, "ready"); assert.equal(forecast.source.metrics.source_basis, "naver-daily"); assert.equal(forecast.source.metrics.security_type, "unknown");
    cache.symbols.push("000660"); await writeFile(join(root, "data", "daily-history", `${target}.json`), JSON.stringify(cache));
    const partialFetch = async url => url.includes("marketValue") ? respond({ totalCount: 2, stocks: [{ itemCode: "005930", stockName: "A" }, { itemCode: "000660", stockName: "B" }] }) : respond({ datas: [quote, { ...quote, symbolCode: "000660", stockName: "B" }] });
    const partial = await createNaverCrawlProvider(withNaverRobots({ env, fetchImpl: partialFetch, now: () => forecastTime, runStartedAt: forecastTime.toISOString() })).generateForecast();
    assert.equal(partial.status, "partial"); assert.equal(partial.source.partial, true); assert.equal(partial.source.metrics.history_status, "partial"); assert.equal(partial.rows.find(r => r.symbol === "000660").expected_open, null);
    const saved = JSON.stringify(noDataSnapshot()), snapshotPath = join(root, "original.json"); await writeFile(snapshotPath, saved);
    const oldHistory = process.env.KOSPI_DAILY_HISTORY; process.env.KOSPI_DAILY_HISTORY = "naver-cache";
    try {
      const stage = await run(["--mode", "forecast", "--provider", "naver-crawl", "--run-date", target, "--run-started-at", forecastTime.toISOString(), "--data-file", snapshotPath], { now: () => forecastTime, fetchImpl: naverRobotsFetch(partialFetch) });
      assert.equal(stage.status, "partial"); assert.equal(stage.wroteFile, false); assert.equal(await readFile(snapshotPath, "utf8"), saved);
    } finally { if (oldHistory === undefined) delete process.env.KOSPI_DAILY_HISTORY; else process.env.KOSPI_DAILY_HISTORY = oldHistory; }
    const openTime = new Date("2026-10-27T00:00:01Z"); quote.localTradedAt = "2026-10-27T08:59:59+09:00";
    const opened = await createNaverCrawlProvider(withNaverRobots({ env, fetchImpl, now: () => openTime, runStartedAt: openTime.toISOString() })).settleOpen();
    assert.equal(opened.status, "degraded"); assert.equal(opened.rows.length, 0);
    const closeTime = new Date("2026-10-27T06:30:01Z"); quote.localTradedAt = "2026-10-27T15:29:59+09:00";
    const closed = await createNaverCrawlProvider(withNaverRobots({ env, fetchImpl, now: () => closeTime, runStartedAt: closeTime.toISOString() })).settleClose();
    assert.equal(closed.status, "degraded"); assert.equal(closed.rows.length, 0);
  } finally { process.chdir(old); delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
});
