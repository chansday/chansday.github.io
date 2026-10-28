import test from "node:test";
import assert from "node:assert/strict";
import { collectNaverUniverse, createNaverCrawlProvider } from "../providers/naver-crawl-provider.js";
import { naverRobotsFetch, withNaverRobots } from "./naver-robots-helper.mjs";

const time = new Date("2026-10-26T23:20:00Z");
const row = symbol => ({ itemCode: symbol, stockName: symbol, stockEndType: "stock", sosok: "0" });
const response = payload => ({ ok: true, status: 200, headers: { get: key => key === "content-type" ? "application/json" : null }, text: async () => JSON.stringify(payload) });
const quote = symbol => ({ symbolCode: symbol, openPriceRaw: 100, closePriceRaw: 100, localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN" });

async function runPages(pages, size = 2) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes("marketValue")) return response(pages[Number(new URL(url).searchParams.get("page")) - 1] || { stocks: [] });
    return response({ datas: [quote("000001"), quote("000003")] });
  };
  const env = { KOSPI_CRAWL_UNIVERSE_PAGE_SIZE: String(size), KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0" };
  const provider = createNaverCrawlProvider(withNaverRobots({ env, fetchImpl, now: () => time, runStartedAt: time.toISOString() }));
  return { result: await provider.generateForecast(), calls };
}

test("truncated 101-stock universe cannot become ready or fetch quotes", async () => {
  const partial = { totalCount: 101, stocks: [row("000001")] };
  const universe = await collectNaverUniverse(withNaverRobots({ fetchImpl: async () => response(partial) }));
  assert.equal(universe.ok, false); assert.match(universe.reason, /expected 100 raw rows, received 1/);
  const { result, calls } = await runPages([partial, { totalCount: 101, stocks: [] }], 100);
  assert.equal(result.status, "degraded"); assert.match(result.message, /incomplete/); assert.ok(calls.every(url => !url.includes("polling.finance")));
});

test("all raw pages must be complete and consistent before security filtering", async () => {
  const good = [{ totalCount: 3, stocks: [row("000001"), { ...row("000002"), stockEndType: "fund" }] }, { totalCount: 3, stocks: [row("000003")] }];
  const pass = await runPages(good); assert.equal(pass.result.status, "ready"); assert.equal(pass.result.rows.length, 2);
  for (const pages of [
    [{ totalCount: 3, stocks: [row("000001"), row("000002")] }, { totalCount: 3, stocks: [] }],
    [{ totalCount: 3, stocks: [row("000001"), row("000002")] }, { totalCount: 3, stocks: [row("000001")] }],
    [{ totalCount: 3, stocks: [row("000001"), row("000002")] }, { totalCount: 4, stocks: [row("000003")] }],
    [{ totalCount: 3, stocks: [row("000001"), row("bad")] }],
    [{ totalCount: null, stocks: [row("000001")] }],
    [{ totalCount: 2, stocks: [row("000001"), { ...row("000002"), stockName: {} }] }],
    [{ totalCount: 1, stocks: [row("000001"), row("000002")] }],
  ]) {
    const { result, calls } = await runPages(pages);
    assert.equal(result.status, "degraded"); assert.ok(calls.every(url => !url.includes("polling.finance")));
  }
});
