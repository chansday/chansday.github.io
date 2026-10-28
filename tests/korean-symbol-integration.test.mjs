import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKoreanSymbol } from "../providers/korean-symbol.js";
import { collectNaverDailyRows } from "../providers/naver-daily-rows.js";
import { loadNaverDailyHistory } from "../providers/naver-daily-cache.js";
import { isSnapshot } from "../providers/provider-adapter.js";
import { collectDaily } from "../scripts/collect-naver-daily.mjs";
import { run } from "../scripts/update-results.mjs";
import { createNaverCrawlProvider } from "../providers/naver-crawl-provider.js";
import { naverRobotsFetch, withNaverRobots } from "./naver-robots-helper.mjs";

const symbol = "0126Z0";
const response = payload => ({ ok: true, status: 200, headers: { get: name => name === "content-type" ? "application/json" : null }, text: async () => JSON.stringify(payload) });

test("Korean symbols are exactly six uppercase ASCII alphanumerics", async () => {
  for (const value of [symbol, "005930", "ABC123"]) assert.equal(isKoreanSymbol(value), true);
  for (const value of ["0126z0", "0126Z", "0126Z00", "0126/0", "0126%0", "０１２６Z０", "0126Z0\n", 123456, null]) {
    assert.equal(isKoreanSymbol(value), false);
    await assert.rejects(collectNaverDailyRows({ symbols: [value], targetDate: "2026-10-27", fetchImpl: async () => { throw new Error("must not request"); } }), /Invalid collection configuration/);
  }
});

test("alphanumeric symbol flows through daily request, cache, universe, quote and snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "kospi-symbol-")), old = process.cwd(), envBefore = process.env.KOSPI_DAILY_HISTORY;
  const prior = ["2026-10-26", "2026-10-23", "2026-10-22", "2026-10-21"];
  const daily = [...prior].reverse().map(date => ({ localDate: date.replaceAll("-", ""), openPrice: 100.0, highPrice: 120.0, lowPrice: 90.0, closePrice: 110.0, accumulatedTradingVolume: 100 }));
  const urls = [], nowBefore = () => new Date("2026-10-26T22:50:00Z");
  try {
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const universeFetcher = async () => ({ ok: true, symbols: [{ symbol }] });
    const collector = options => collectNaverDailyRows({ ...options, clock: () => nowBefore().getTime(), fetchImpl: naverRobotsFetch(async url => { urls.push(url); return response(daily); }) });
    const collected = await collectDaily({ now: nowBefore, universeFetcher, collector, sleep: async () => {} });
    assert.equal(collected.status, "ready"); assert.match(urls[0], /^https:\/\/api\.stock\.naver\.com\/chart\/domestic\/item\/0126Z0\/day\?/);
    const history = await loadNaverDailyHistory({ targetDate: "2026-10-27", now: () => new Date("2026-10-26T23:20:00Z") });
    assert.equal(history.ok, true); assert.equal(history.sessions[0].rows[0].symbol, symbol); assert.equal(history.comparison_conflicts, 0); assert.equal(history.robots_url, "https://api.stock.naver.com/robots.txt"); assert.equal(history.robots_status, 404);
    const record = JSON.parse(await readFile(collected.path, "utf8")); assert.deepEqual(record.warnings, []); assert.ok(record.sessions.every(s => s.rows.every(r => r.comparison === "unverified")));
    process.env.KOSPI_DAILY_HISTORY = "naver-cache";
    const stageTime = new Date("2026-10-26T23:20:00Z");
    const fetchImpl = async url => { urls.push(url); return url.includes("marketValue") ? response({ totalCount: 1, stocks: [{ itemCode: symbol, stockName: "A", stockEndType: "stock", sosok: "0" }] }) : response({ datas: [{ symbolCode: symbol, stockName: "A", openPriceRaw: 100, closePriceRaw: 110, localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "OPEN" }] }); };
    const result = await createNaverCrawlProvider(withNaverRobots({ env: { KOSPI_DAILY_HISTORY: "naver-cache", KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0" }, now: () => stageTime, runStartedAt: stageTime.toISOString(), fetchImpl })).generateForecast();
    assert.equal(result.status, "ready"); assert.equal(result.rows[0].symbol, symbol); assert.equal(result.rows[0].prior_close, 110);
    const stage = await run(["--mode", "forecast", "--provider", "naver-crawl", "--run-date", "2026-10-27", "--run-started-at", stageTime.toISOString()], { now: () => stageTime, fetchImpl: naverRobotsFetch(fetchImpl) });
    assert.equal(stage.status, "ready"); assert.equal(stage.source.metrics.source_basis, "naver-daily"); assert.match(stage.source.metrics.history_reason, /0 daily comparison conflicts/); assert.match(stage.message, /market and adjustment basis unconfirmed/); assert.ok(urls.some(url => url.endsWith(`/stock/${symbol}`)));
    const snapshot = JSON.parse(await readFile(join(root, "data", "latest-snapshot.json"), "utf8"));
    assert.equal(snapshot.rows[0].symbol, symbol); assert.equal(snapshot.rows[0].prior_close, 110); assert.equal(isSnapshot(snapshot), true);
    snapshot.rows[0].symbol = "0126/0"; assert.equal(isSnapshot(snapshot), false);
    const schema = JSON.parse(await readFile(new URL("../schema/market-snapshot.schema.json", import.meta.url)));
    assert.equal(new RegExp(schema.allOf[0].then.properties.rows.items.properties.symbol.pattern).test(symbol), true);
    assert.equal(new RegExp(schema.allOf[0].then.properties.rows.items.properties.symbol.pattern).test("0126/0"), false);
  } finally { if (envBefore === undefined) delete process.env.KOSPI_DAILY_HISTORY; else process.env.KOSPI_DAILY_HISTORY = envBefore; process.chdir(old); delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
});
