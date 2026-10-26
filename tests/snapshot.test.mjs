import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  emptyRow,
  isProviderAdapter,
  isSnapshot,
  validateRankingRows,
} from "../providers/provider-adapter.js";
import { createDemoProvider } from "../providers/demo-provider.js";
import { createFixtureProvider, FIXTURE_DATES } from "../providers/fixture-provider.js";
import { createPublicJsonProvider } from "../providers/public-json-provider.js";
import { createPublicCsvProvider } from "../providers/public-csv-provider.js";

test("static snapshot follows the top-level contract and is visibly test-only", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/latest-snapshot.json", import.meta.url), "utf8"));
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(snapshot.market.name, "KOSPI");
  assert.equal(snapshot.market.timezone, "Asia/Seoul");
  assert.equal(snapshot.mode, "historical_test");
  assert.equal(snapshot.meta.historical_test, true);
  assert.equal(snapshot.meta.test_only, true);
  assert.equal(snapshot.provider.id, "historical-test");
  assert.equal(snapshot.rows.length, 913);
  assert.equal(snapshot.meta.source_rows, 913);
  assert.equal(snapshot.pipeline.openSettlement.status, "ready");
  assert.equal(snapshot.pipeline.closeSettlement.status, "ready");
});

test("historical-test snapshots contain observed OHLC-volume values and no future-leaking baseline inputs", async () => {
  const expectedInputDates = { "2026-10-22": "2026-10-21", "2026-10-23": "2026-10-22" };
  for (const date of Object.keys(expectedInputDates)) {
    const snapshot = JSON.parse(await readFile(new URL(`../data/historical-test/${date}.json`, import.meta.url), "utf8"));
    assert.equal(isSnapshot(snapshot), true);
    assert.equal(snapshot.mode, "historical_test");
    assert.equal(snapshot.provider.id, "historical-test");
    assert.equal(snapshot.meta.historical_test, true);
    assert.equal(snapshot.meta.test_only, true);
    assert.equal(snapshot.baseline.input_through_date, expectedInputDates[date]);
    assert.equal(snapshot.meta.source_rows, snapshot.rows.length);
    assert.equal(snapshot.rows.length, 913);
    assert.equal(snapshot.rows.every((row) => ["expected_open", "expected_return", "actual_open", "actual_close", "actual_return", "actual_volume", "prior_close", "error"].every((field) => typeof row[field] === "number" && Number.isFinite(row[field]))), true);
    assert.equal(snapshot.rows.every((row) => row.expected_close === null), true);
    assert.equal(snapshot.rows.every((row) => row.confidence === null), true);
    assert.equal(snapshot.rows.every((row) => row.quality === "historical_baseline_no_preopen_quote"), true);
    assert.equal(snapshot.rows.every((row) => Math.abs(row.actual_return - ((row.actual_open / row.prior_close - 1) * 100)) < 0.011), true);
    assert.equal(snapshot.rows.every((row) => Math.abs(row.expected_return - ((row.expected_open / row.prior_close - 1) * 100)) < 0.011), true);
    assert.equal(snapshot.rows.every((row) => Math.abs(row.error - (row.actual_return - row.expected_return)) < 0.011), true);
    assert.match(snapshot.pipeline.forecast.message, new RegExp(expectedInputDates[date]));
    assert.match(snapshot.provider.source.url, new RegExp(date.replaceAll("-", "")));
  }
});

test("ranking schema uses snake_case financial fields and rejects legacy names", () => {
  const row = emptyRow({
    rank: 1,
    symbol: "TEST",
    name: "검증용",
    expected_open: 100,
    expected_close: 101,
    expected_return: 1,
  });
  assert.equal(validateRankingRows([row]).valid, true);
  assert.equal(validateRankingRows([{ ...row, expectedOpen: 100 }]).valid, false);
});

test("demo provider implements the adapter without financial numbers", async () => {
  const provider = createDemoProvider();
  assert.equal(isProviderAdapter(provider), true);
  const snapshot = await provider.getSnapshot();
  assert.equal(snapshot.status, "demo");
  assert.equal(snapshot.meta.isDemo, true);
  for (const row of snapshot.rows) {
    assert.equal(row.expected_open, null);
    assert.equal(row.expected_close, null);
    assert.equal(row.actual_open, null);
    assert.equal(row.actual_close, null);
    assert.equal(row.expected_return, null);
    assert.equal(row.actual_return, null);
    assert.equal(row.error, null);
  }
});

test("public JSON provider is disabled without explicit source policy", async () => {
  const provider = createPublicJsonProvider({ env: {} });
  assert.equal(isProviderAdapter(provider), true);
  assert.equal(provider.getSourceMetadata(), null);
  const result = await provider.generateForecast();
  assert.equal(result.status, "degraded");
  assert.equal(result.rows.length, 0);
  assert.match(result.message, /explicit URL|license/i);
});

test("public CSV provider uses bounded bulk collection and never fabricates pre-market values", async () => {
  const csv = (date, close) => [
    "basDt,mrktCtg,종목코드,종목명,mkp,clpr,trqu",
    `${date},KOSPI,000001,공개종목,100,${close},1000`,
    `${date},KOSPI,000002,다른종목,200,${close * 2},2000`,
  ].join("\n");
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const date = url.match(/quotes_(\d{8})\.csv/)?.[1];
    const body = date === "20261023" ? csv(date, 110) : date === "20261022" ? csv(date, 100) : null;
    if (!body) return { ok: false, status: 404, headers: { get: () => "text/plain" }, text: async () => "not found" };
    return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "text/csv" : null }, text: async () => body };
  };
  const provider = createPublicCsvProvider({
    env: { KOSPI_PUBLIC_MAX_RETRIES: "0", KOSPI_PUBLIC_MAX_CONCURRENCY: "2", GITHUB_RUN_ID: "test-run" },
    fetchImpl,
    now: () => new Date("2026-10-25T23:10:00.000Z"),
  });
  const observed = await provider.fetchPreviousDay();
  assert.equal(observed.status, "ready");
  assert.equal(observed.rows.length, 2);
  assert.equal(observed.rows.every((row) => row.expected_open === null && row.expected_return === null), true);
  assert.equal(observed.source.source_id, "aikstockdata-public-daily-csv");
  assert.equal(observed.source.run_id, "test-run");
  assert.equal(observed.source.metrics.max_concurrency, 2);
  assert.equal(observed.source.metrics.requested, calls.length);

  const forecast = await provider.generateForecast();
  assert.equal(forecast.status, "ready");
  assert.equal(forecast.rows.length, 2);
  assert.equal(forecast.rows.every((row) => row.expected_open !== null && row.expected_return !== null && row.actual_open === null && row.quality === "public_baseline_no_preopen_quote"), true);
  assert.match(forecast.message, /baseline|pre-market|order book/i);
  const openSettlement = await provider.settleOpen();
  assert.equal(openSettlement.status, "no_data");
  assert.match(openSettlement.message, /09:00|actual_open|no_data/i);
});

test("fixture snapshots are explicit synthetic data for both requested dates", async () => {
  for (const date of FIXTURE_DATES) {
    const snapshot = JSON.parse(await readFile(new URL(`../data/fixtures/${date}.json`, import.meta.url), "utf8"));
    assert.equal(isSnapshot(snapshot), true);
    assert.equal(snapshot.asOfDate, date);
    assert.equal(snapshot.mode, "fixture");
    assert.equal(snapshot.provider.id, "fixture");
    assert.equal(snapshot.meta.isDemo, true);
    assert.match(snapshot.meta.fixture_note, /SYNTHETIC/i);
    assert.equal(snapshot.rows.length, 3);
    assert.equal(snapshot.pipeline.forecast.status, "demo");
    assert.equal(snapshot.pipeline.openSettlement.status, "demo");
    assert.match(snapshot.pipeline.forecast.message, /08:30|재구성하지 않았습니다/);

    const provider = createFixtureProvider({ env: { KOSPI_FIXTURE_DATE: date } });
    assert.equal(isProviderAdapter(provider), true);
    const forecast = await provider.generateForecast();
    const settlement = await provider.settleClose();
    assert.equal(forecast.status, "demo");
    assert.equal(forecast.rows.every((row) => row.expected_open !== null && row.actual_open === null && row.error === null), true);
    assert.equal(settlement.status, "demo");
    assert.equal(settlement.rows.every((row) => row.expected_open !== null && row.actual_open !== null && row.error !== null), true);
  }
});


test("baseline replay snapshots are explicit synthetic previous-close simulations", async () => {
  for (const date of ["2026-10-22", "2026-10-23"]) {
    const snapshot = JSON.parse(await readFile(new URL(`../data/replays/${date}.json`, import.meta.url), "utf8"));
    assert.equal(isSnapshot(snapshot), true);
    assert.equal(snapshot.mode, "replay");
    assert.equal(snapshot.provider.id, "replay_baseline");
    assert.equal(snapshot.meta.isDemo, true);
    assert.equal(snapshot.meta.replay_type, "replay_baseline");
    assert.equal(snapshot.baseline.basis, "previous_session_close");
    assert.equal(snapshot.rows.every((row) => row.expected_open !== null && row.actual_open !== null && row.error !== null), true);
  }
});

test("backfill test snapshots are isolated synthetic copies of replay numeric flow", async () => {
  const fields = ["expected_open", "expected_close", "expected_return", "actual_open", "actual_close", "actual_return", "error"];
  for (const date of ["2026-10-22", "2026-10-23"]) {
    const backfill = JSON.parse(await readFile(new URL("../data/backfill-test/" + date + ".json", import.meta.url), "utf8"));
    const replay = JSON.parse(await readFile(new URL("../data/replays/" + date + ".json", import.meta.url), "utf8"));
    assert.equal(isSnapshot(backfill), true);
    assert.equal(backfill.mode, "backfill_test");
    assert.equal(backfill.provider.id, "backfill-test");
    assert.equal(backfill.meta.isDemo, true);
    assert.equal(backfill.meta.backfill, true);
    assert.equal(backfill.meta.backfill_source_replay_date, date);
    assert.match(backfill.meta.backfill_note, /TEST ONLY|real financial/i);
    assert.deepEqual(backfill.rows.map((row) => fields.map((field) => row[field])), replay.rows.map((row) => fields.map((field) => row[field])));
    assert.equal(backfill.rows.every((row) => fields.every((field) => typeof row[field] === "number")), true);
  }
});
