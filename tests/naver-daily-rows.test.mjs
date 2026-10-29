import test from "node:test";
import assert from "node:assert/strict";
import { collectNaverDailyRows, dailyChartUrl, parseNaverChartDailyRows } from "../providers/naver-daily-rows.js";
import { naverRobotsFetch } from "./naver-robots-helper.mjs";

const bar = (date, open, close, extra = {}) => ({ localDate: date.replaceAll("-", ""), openPrice: open, closePrice: close, highPrice: 250.0, lowPrice: 50.0, accumulatedTradingVolume: 100, foreignRetentionRate: 1.5, ...extra });
const options = { symbol: "005930", targetDate: "2026-10-28" };
const json = (payload) => ({ status: 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(payload) });

test("chart URL targets api.stock.naver.com and ends the day before the target", () => {
  assert.equal(dailyChartUrl("005930", "2026-10-28"), "https://api.stock.naver.com/chart/domestic/item/005930/day?startDateTime=202610070000&endDateTime=202610272359");
  assert.throws(() => dailyChartUrl("0059/0", "2026-10-28"));
});

test("chart rows exclude today, return newest first and never derive a comparison", () => {
  const result = parseNaverChartDailyRows([bar("2026-10-23", 190.0, 200.0), bar("2026-10-26", 200.0, 213.0), bar("2026-10-27", 200.0, 225.0), bar("2026-10-28", 200.0, 240.0)], options);
  assert.deepEqual(result.rejected, []); assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.rows.map(r => [r.date, r.open, r.close, r.comparison]), [["2026-10-27", 200, 225, "unverified"], ["2026-10-26", 200, 213, "unverified"], ["2026-10-23", 190, 200, "unverified"]]);
  assert.equal(result.license_status, "unconfirmed"); assert.equal(result.market_venue, "unconfirmed");
});

test("reject invalid OHLC, non-integer values and unordered or future dates", () => {
  assert.equal(parseNaverChartDailyRows([bar("2026-10-27", 200, 225, { highPrice: 210 })], options).rejected[0].reason, "invalid_ohlcv");
  assert.throws(() => parseNaverChartDailyRows([bar("2026-10-27", 200, 225), bar("2026-10-26", 200, 213)], options), /ascending/);
  assert.throws(() => parseNaverChartDailyRows([bar("2026-10-27", 200, 225), bar("2026-10-27", 200, 225)], options), /unique/);
  assert.throws(() => parseNaverChartDailyRows([bar("2026-10-29", 200, 225)], options), /Future/);
  assert.throws(() => parseNaverChartDailyRows([bar("2026-02-30", 200, 225)], options), /valid/);
  assert.throws(() => parseNaverChartDailyRows([{ ...bar("2026-10-27", 200, 225), localDate: "2026-10-27" }], options), /valid/);
  assert.equal(parseNaverChartDailyRows([bar("2026-10-28", 200, 225)], options).rows.length, 0);
  for (const field of ["openPrice", "closePrice", "highPrice", "lowPrice", "accumulatedTradingVolume"]) {
    for (const value of [null, 0, "200", 200.5, -1]) {
      // Only a JSON number 0 volume is the source reporting no trade.
      const expected = field === "accumulatedTradingVolume" && value === 0 ? "zero_volume" : "invalid_ohlcv";
      assert.equal(parseNaverChartDailyRows([bar("2026-10-27", 200, 225, { [field]: value })], options).rejected[0].reason, expected, `${field}=${value}`);
    }
  }
});

test("rate limiting stops at once without waiting, rotating headers or requesting remaining symbols", async () => {
  let time = 0; const calls = []; const sleeps = [];
  const result = await collectNaverDailyRows({ symbols: ["005930", "000660"], targetDate: options.targetDate, clock: () => time,
    sleep: async ms => { sleeps.push(ms); time += ms; }, fetchImpl: naverRobotsFetch(async (url, init) => { calls.push([url, init.headers["User-Agent"]]); return { status: 429, headers: new Headers({ "retry-after": "2" }), text: async () => "" }; }) });
  assert.equal(result.status, "blocked"); assert.equal(calls.length, 1); assert.deepEqual(sleeps, []);
  assert.equal(result.retry_not_before, new Date(2000).toISOString());
  assert.equal(calls[0][1], "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)");
});

test("successful requests are at least 500 ms apart, robots is fetched once and malformed rows stay partial", async () => {
  let time = 0; const calls = []; const robots = [];
  const inner = async url => { calls.push(time); return json([]); };
  const fetchImpl = async (url, init) => { if (String(url).endsWith("/robots.txt")) robots.push(url); return naverRobotsFetch(inner)(url, init); };
  const result = await collectNaverDailyRows({ symbols: ["005930", "000660"], targetDate: options.targetDate, clock: () => time, sleep: async ms => { time += ms; }, fetchImpl });
  assert.deepEqual(calls, [0, 500]); assert.equal(result.status, "partial"); assert.equal(result.rejected.length, 2);
  assert.deepEqual(robots, ["https://api.stock.naver.com/robots.txt"]);
  assert.equal(result.robots_status, 404); assert.equal(result.robots_url, "https://api.stock.naver.com/robots.txt");
});

test("robots denial or unavailable robots on the chart host stops before any data request", async () => {
  for (const [status, text, reason] of [[200, "User-agent: *\nDisallow: /\n", /robots disallows \/chart\/domestic\/item\/005930\/day/], [503, "", /robots unavailable: HTTP 503/], [406, "", /robots unavailable: HTTP 406/]]) {
    const data = [];
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/robots.txt")) return { ok: status === 200, status, headers: new Headers({ "content-type": "text/plain" }), text: async () => text };
      data.push(url); return json([]);
    };
    const result = await collectNaverDailyRows({ symbols: ["005930"], targetDate: options.targetDate, fetchImpl, sleep: async () => {} });
    assert.equal(result.status, "blocked"); assert.match(result.reason, reason); assert.deepEqual(data, []);
  }
});
