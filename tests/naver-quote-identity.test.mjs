import test from "node:test";
import assert from "node:assert/strict";
import { createNaverCrawlProvider } from "../providers/naver-crawl-provider.js";
import { naverRobotsFetch, withNaverRobots } from "./naver-robots-helper.mjs";

const time = new Date("2026-10-26T23:20:00Z");
const quote = symbol => ({ symbolCode: symbol, stockName: symbol, openPriceRaw: 100, closePriceRaw: 100, localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN" });
const respond = payload => ({ ok: true, status: 200, headers: { get: key => key === "content-type" ? "application/json" : null }, text: async () => JSON.stringify(payload) });

async function collect(rows, batchSize = 100) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return url.includes("marketValue") ? respond({ totalCount: 2, stocks: [{ itemCode: "005930" }, { itemCode: "000660" }] }) : respond({ datas: typeof rows === "function" ? rows(url) : rows });
  };
  const env = { KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0", KOSPI_CRAWL_QUOTE_BATCH_SIZE: String(batchSize) };
  const provider = createNaverCrawlProvider(withNaverRobots({ env, fetchImpl, now: () => time, runStartedAt: time.toISOString() }));
  return { result: await provider.generateForecast(), calls };
}

test("two requested stocks must each appear exactly once", async () => {
  const normal = await collect([quote("005930"), quote("000660")]);
  assert.equal(normal.result.status, "ready"); assert.equal(normal.result.rows.length, 2);
  for (const [rows, reason] of [
    [[quote("005930")], /missing=1, duplicate=0, unknown=0/],
    [[quote("005930"), quote("005930"), quote("000660")], /missing=0, duplicate=1, unknown=0/],
    [[quote("005930"), quote("000660"), quote("035420")], /missing=0, duplicate=0, unknown=1/],
    [[quote("005930"), quote("000660"), quote("invalid")], /missing=0, duplicate=0, unknown=1/],
  ]) {
    const { result } = await collect(rows);
    assert.equal(result.status, "degraded"); assert.equal(result.rows.length, 0); assert.equal(result.source.partial, true); assert.match(result.message, reason);
  }
});

test("a symbol returned for the wrong request batch is rejected", async () => {
  const { result, calls } = await collect(() => [quote("000660")], 1);
  assert.equal(result.status, "degraded"); assert.match(result.message, /missing=1, duplicate=0, unknown=1/);
  assert.equal(calls.filter(url => url.includes("polling.finance")).length, 1);
});
