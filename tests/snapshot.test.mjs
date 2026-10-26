import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  emptyRow,
  isProviderAdapter,
  isSnapshot,
  validateRankingRows,
} from "../providers/provider-adapter.js";
import {
  HISTORICAL_TEST_REQUIRED_FIELDS,
  historicalTestRunPath,
  isHistoricalTestSnapshot,
  isLiveNoDataSnapshot,
  markHistoricalTestFallback,
} from "../providers/historical-test-fallback.js";
import { createDemoProvider } from "../providers/demo-provider.js";
import { createFixtureProvider, FIXTURE_DATES } from "../providers/fixture-provider.js";
import { createPublicJsonProvider } from "../providers/public-json-provider.js";
import { createPublicCsvProvider } from "../providers/public-csv-provider.js";
import { mergeRows } from "../scripts/update-results.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("latest snapshot is an operating screen copy, not the historical-test dataset", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/latest-snapshot.json", import.meta.url), "utf8"));
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(snapshot.market.name, "KOSPI");
  assert.equal(snapshot.market.timezone, "Asia/Seoul");
  assert.notEqual(snapshot.mode, "historical_test");
  assert.notEqual(snapshot.meta?.historical_test, true);
  assert.notEqual(snapshot.meta?.test_only, true);
  assert.equal(snapshot.meta.run_stage, "update-results");
});

test("historical fallback is eligible only for live no_data and keeps observed fields from the isolated run", async () => {
  const liveNoData = {
    schemaVersion: "1.0.0",
    mode: "provider",
    status: "no_data",
    provider: { id: null },
    meta: { isDemo: false, historical_test: false, test_only: false },
  };
  assert.equal(isLiveNoDataSnapshot(liveNoData), true);
  for (const status of ["ready", "partial", "degraded", "stale", "blocked", "pending"]) {
    assert.equal(isLiveNoDataSnapshot({ ...liveNoData, status }), false, `${status} must not select historical fallback`);
  }

  const runPath = historicalTestRunPath("2026-10-23");
  assert.equal(runPath, "data/runs/historical-test/2026-10-23/1530.json");
  const historical = JSON.parse(await readFile(join(PROJECT_ROOT, runPath), "utf8"));
  assert.equal(isHistoricalTestSnapshot(historical), true);
  assert.equal(historical.meta.latest_snapshot_untouched, true);
  assert.equal(historical.rows.every((row) => HISTORICAL_TEST_REQUIRED_FIELDS.every((field) => Object.hasOwn(row, field) && typeof row[field] === "number" && Number.isFinite(row[field]))), true);

  const fallback = markHistoricalTestFallback(historical, liveNoData, runPath);
  assert.notEqual(fallback, historical);
  assert.notEqual(fallback.meta, historical.meta);
  assert.deepEqual(fallback.rows, historical.rows);
  assert.equal(fallback.meta.historical_fallback, true);
  assert.equal(fallback.meta.historical_fallback_reason, "live_provider_no_data");
  assert.equal(fallback.meta.historical_fallback_source, runPath);
  assert.equal(fallback.meta.live_snapshot_status, "no_data");
});

test("operating UI declares historical fallback as not live and reads only isolated run paths", async () => {
  const app = await readFile(join(PROJECT_ROOT, "app.js"), "utf8");
  assert.match(app, /HISTORICAL TEST \/ NOT LIVE/);
  assert.match(app, /isLiveNoDataSnapshot/);
  assert.match(app, /historical_fallback_source/);
  assert.match(app, /data\/runs\/historical-test/);
  assert.doesNotMatch(app, /data\/historical-test\//);
});

test("canonical stage runs preserve fields, settle cumulatively, and are idempotent", async () => {
  const tempRoot = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", "kospi-run-"));
  const fixtureSource = join(PROJECT_ROOT, "data", "fixtures", "2026-10-23.json");
  const fixtureTarget = join(tempRoot, "data", "fixtures", "2026-10-23.json");
  const script = join(PROJECT_ROOT, "scripts", "update-results.mjs");
  const modes = ["update-results", "analysis", "forecast", "open-settlement", "close-settlement"];
  const args = ["--provider", "fixture", "--fixture-date", "2026-10-23", "--run-date", "2026-10-23"];
  try {
    await mkdir(join(tempRoot, "data", "fixtures"), { recursive: true });
    await cp(fixtureSource, fixtureTarget);
    for (const mode of modes) await execFileAsync(process.execPath, [script, "--mode", mode, ...args], { cwd: tempRoot });

    const stage = async (name) => JSON.parse(await readFile(join(tempRoot, "data", "runs", "2026-10-23", `${name}.json`), "utf8"));
    const stage0700 = await stage("0700");
    const stage0800 = await stage("0800");
    const stage0820 = await stage("0820");
    const stage0900 = await stage("0900");
    const stage1530 = await stage("1530");
    assert.equal(stage0700.meta.run_stage, "update-results");
    assert.equal(stage0800.meta.run_stage, "analysis");
    assert.equal(stage0820.rows.every((row) => row.expected_open !== null && row.expected_return !== null && row.actual_open === null), true);
    assert.equal(stage0900.rows.every((row) => row.expected_open !== null && row.actual_open !== null && row.actual_close === null), true);
    assert.equal(stage1530.rows.every((row) => row.expected_open !== null && row.actual_open !== null && row.actual_close !== null), true);
    assert.deepEqual(stage1530.rows.map((row) => row.actual_return), stage0900.rows.map((row) => row.actual_return));
    assert.deepEqual(JSON.parse(await readFile(join(tempRoot, "data", "latest-snapshot.json"), "utf8")), stage1530);

    const before = await Promise.all(modes.map(async (mode) => readFile(join(tempRoot, "data", "runs", "2026-10-23", `${mode === "update-results" ? "0700" : mode === "analysis" ? "0800" : mode === "forecast" ? "0820" : mode === "open-settlement" ? "0900" : "1530"}.json`), "utf8")));
    for (const mode of modes) await execFileAsync(process.execPath, [script, "--mode", mode, ...args], { cwd: tempRoot });
    const after = await Promise.all(modes.map(async (mode) => readFile(join(tempRoot, "data", "runs", "2026-10-23", `${mode === "update-results" ? "0700" : mode === "analysis" ? "0800" : mode === "forecast" ? "0820" : mode === "open-settlement" ? "0900" : "1530"}.json`), "utf8")));
    assert.deepEqual(after, before);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("unavailable settlement preserves previously successful actual fields", async () => {
  const tempRoot = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", "kospi-unavailable-settlement-"));
  const script = join(PROJECT_ROOT, "scripts", "update-results.mjs");
  const dataFile = join(tempRoot, "latest.json");
  const row = {
    rank: 1,
    symbol: "KEEP",
    name: "보존종목",
    expected_open: 101,
    expected_close: null,
    expected_return: 1,
    actual_open: 102,
    actual_close: 105,
    actual_return: 2,
    actual_volume: 1234,
    error: 1,
    confidence: null,
    quality: "settled",
    status: "valid",
  };
  const snapshot = { status: "ready", mode: "provider", provider: { id: "test" }, meta: {}, rows: [row], pipeline: {} };
  try {
    await writeFile(dataFile, `${JSON.stringify(snapshot)}\n`, "utf8");
    for (const mode of ["open-settlement", "close-settlement"]) {
      await execFileAsync(process.execPath, [script, "--mode", mode, "--provider", "none", "--run-date", "2026-10-23", "--data-file", dataFile], { cwd: PROJECT_ROOT });
      const observed = JSON.parse(await readFile(dataFile, "utf8"));
      assert.deepEqual(observed.rows[0], { ...row, error: 1 });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("close settlement preserves actual_return and recalculates error", () => {
  const existing = {
    rank: 1,
    symbol: "CLOSE",
    name: "종가정산",
    expected_open: 101,
    expected_close: null,
    expected_return: 1,
    actual_open: 102,
    actual_close: null,
    actual_return: 2,
    actual_volume: null,
    error: 999,
    confidence: null,
    quality: "open_settled",
    status: "valid",
  };
  const incoming = { ...existing, actual_close: 105, actual_return: 99, actual_volume: 5000, error: null };
  const [merged] = mergeRows([existing], [incoming], "close-settlement");
  assert.equal(merged.actual_close, 105);
  assert.equal(merged.actual_volume, 5000);
  assert.equal(merged.actual_return, 2);
  assert.equal(merged.error, 1);
});

test("historical-test pipeline writes five isolated stage files without touching operating latest", async () => {
  const tempRoot = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", "kospi-historical-stage-"));
  const script = join(PROJECT_ROOT, "scripts", "historical-test-pipeline.mjs");
  const latestBefore = await readFile(join(PROJECT_ROOT, "data", "latest-snapshot.json"), "utf8");
  try {
    await execFileAsync(process.execPath, [script, "--output-root", join(tempRoot, "data", "runs", "historical-test")], { cwd: PROJECT_ROOT });
    for (const date of ["2026-10-22", "2026-10-23"]) {
      const stageFiles = ["0700", "0800", "0820", "0900", "1530"].map((stage) => join(tempRoot, "data", "runs", "historical-test", date, `${stage}.json`));
      const snapshots = await Promise.all(stageFiles.map((path) => readFile(path, "utf8").then(JSON.parse)));
      assert.equal(snapshots.every((snapshot) => snapshot.mode === "historical_test" && snapshot.meta.test_only === true && snapshot.meta.historical_test === true), true);
      assert.equal(snapshots[0].rows.every((row) => row.expected_open !== null && row.expected_return !== null && row.actual_open === null && row.actual_return === null && row.error === null), true);
      assert.equal(snapshots[2].rows.every((row) => row.expected_open !== null && row.expected_return !== null && row.actual_open === null), true);
      assert.equal(snapshots[3].rows.every((row) => row.actual_open !== null && row.actual_return === Math.round(((row.actual_open / row.prior_close - 1) * 100 + Number.EPSILON) * 100) / 100 && row.error === Math.round((row.actual_return - row.expected_return + Number.EPSILON) * 100) / 100), true);
      assert.equal(snapshots[4].rows.every((row) => row.actual_close !== null && row.actual_return === Math.round(((row.actual_open / row.prior_close - 1) * 100 + Number.EPSILON) * 100) / 100 && row.error === Math.round((row.actual_return - row.expected_return + Number.EPSILON) * 100) / 100), true);
      assert.deepEqual(snapshots[2].rows.map((row) => [row.symbol, row.expected_open, row.expected_return]), snapshots[4].rows.map((row) => [row.symbol, row.expected_open, row.expected_return]));
    }
    assert.equal(await readFile(join(PROJECT_ROOT, "data", "latest-snapshot.json"), "utf8"), latestBefore);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("historical-test snapshots contain observed OHLC-volume values and no future-leaking baseline inputs", async () => {
  const expectedInputDates = {
    "2026-10-22": ["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"],
    "2026-10-23": ["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"],
  };
  for (const [date, inputDates] of Object.entries(expectedInputDates)) {
    const snapshot = JSON.parse(await readFile(join(PROJECT_ROOT, "data", "runs", "historical-test", date, "1530.json"), "utf8"));
    assert.equal(isSnapshot(snapshot), true);
    assert.equal(snapshot.mode, "historical_test");
    assert.equal(snapshot.provider.id, "historical-test");
    assert.equal(snapshot.meta.historical_test, true);
    assert.equal(snapshot.meta.test_only, true);
    assert.equal(snapshot.baseline.input_through_date, inputDates.at(-1));
    assert.equal(snapshot.baseline.basis, "public_daily_momentum_volatility");
    assert.equal(snapshot.baseline.input_dates.length, 5);
    assert.deepEqual(snapshot.baseline.input_dates, inputDates);
    assert.equal(snapshot.baseline.model, "public_daily_momentum_volatility_v1");
    assert.equal(snapshot.meta.source_rows, snapshot.rows.length);
    assert.equal(snapshot.rows.length, 913);
    assert.equal(snapshot.rows.every((row) => ["expected_open", "expected_return", "actual_open", "actual_close", "actual_return", "actual_volume", "prior_close", "error"].every((field) => typeof row[field] === "number" && Number.isFinite(row[field]))), true);
    assert.equal(snapshot.rows.every((row) => row.expected_close === null), true);
    assert.equal(snapshot.rows.every((row) => row.confidence === null), true);
    assert.equal(snapshot.rows.every((row) => ["historical_baseline_public_daily", "historical_baseline_public_daily_settled"].includes(row.quality)), true);
    assert.equal(snapshot.rows.some((row) => row.expected_return !== 0), true);
    assert.equal(snapshot.rows.every((row) => row.features && Number.isFinite(row.features.momentum) && Number.isFinite(row.features.volatility)), true);
    assert.equal(snapshot.rows.every((row) => Math.abs(row.actual_return - ((row.actual_open / row.prior_close - 1) * 100)) < 0.011), true);
    assert.equal(snapshot.rows.every((row) => Math.abs(row.expected_return - ((row.expected_open / row.prior_close - 1) * 100)) < 0.011), true);
    assert.equal(snapshot.rows.every((row) => Math.abs(row.error - (row.actual_return - row.expected_return)) < 0.011), true);
    assert.match(snapshot.pipeline.forecast.message, new RegExp(`${inputDates.at(-1)}|Historical-test stage 0820`));
    assert.match(snapshot.provider.source.url, new RegExp(date.replaceAll("-", "")));
  }
});

test("historical-test page exposes the baseline and missing pre-open quote status", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /HISTORICAL-TEST \/ TEST ONLY/);
  assert.match(app, /공개 일봉 모멘텀·변동성 baseline/);
  assert.match(app, /장전 호가가 없어/);
  assert.match(app, /isTestOnlySnapshot\(data\)/);
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
  assert.equal(observed.rows.every((row) => row.actual_return === 0 && row.error === null), true);
  assert.equal(observed.rows.every((row) => row.actual_close === 110 || row.actual_close === 220), true);
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

