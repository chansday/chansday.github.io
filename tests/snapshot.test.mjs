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

test("static snapshot follows the top-level contract", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/latest-snapshot.json", import.meta.url), "utf8"));
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(snapshot.market.name, "KOSPI");
  assert.equal(snapshot.market.timezone, "Asia/Seoul");
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.status, "no_data");
  assert.equal(snapshot.meta.source, null);
  assert.equal(snapshot.pipeline.closeSettlement.status, "pending");
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
