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
import { EXPECTED_DISPLAY_POLICY, isEvaluationSummary } from "../providers/evaluation-contract.js";
import { createDemoProvider } from "../providers/demo-provider.js";
import { createFixtureProvider, FIXTURE_DATES } from "../providers/fixture-provider.js";
import { createPublicJsonProvider } from "../providers/public-json-provider.js";
import { createPublicCsvProvider } from "../providers/public-csv-provider.js";
import { createNaverCrawlProvider, parseLocalTradedAt, resolveCrawlStage } from "../providers/naver-crawl-provider.js";
import { calculateRunContext, resolveProvider, run as runStage } from "../scripts/update-results.mjs";
import { mergeRows } from "../scripts/update-results.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OPERATING_RUN_STAGES = new Set(["update-results", "analysis", "forecast", "open-settlement", "close-settlement"]);

async function execExpectNonReady(command, args, options) {
  await assert.rejects(
    execFileAsync(command, args, options),
    (error) => error.code === 2 || error.status === 2,
  );
}

test("latest snapshot is an operating screen copy and uses the immutable stage contract", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/latest-snapshot.json", import.meta.url), "utf8"));
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(snapshot.market.name, "KOSPI");
  assert.equal(snapshot.market.timezone, "Asia/Seoul");
  assert.notEqual(snapshot.mode, "historical_test");
  assert.notEqual(snapshot.meta?.historical_test, true);
  assert.notEqual(snapshot.meta?.test_only, true);
  assert.equal(OPERATING_RUN_STAGES.has(snapshot.meta.run_stage), true);
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

test("historical-test snapshots expose a normalized, test-only evaluation contract", async () => {
  const source = JSON.parse(await readFile(join(PROJECT_ROOT, "data", "historical-test", "2026-10-23.json"), "utf8"));
  const forecast = JSON.parse(await readFile(join(PROJECT_ROOT, "data", "runs", "historical-test", "2026-10-23", "0820.json"), "utf8"));
  const settled = JSON.parse(await readFile(join(PROJECT_ROOT, "data", "runs", "historical-test", "2026-10-23", "1530.json"), "utf8"));
  for (const snapshot of [source, forecast, settled]) {
    assert.equal(isEvaluationSummary(snapshot.evaluation), true);
    assert.equal(snapshot.evaluation.test_only, true);
    assert.equal(snapshot.evaluation.dataset, "historical_test");
    assert.deepEqual(snapshot.evaluation.display_policy, EXPECTED_DISPLAY_POLICY);
    assert.deepEqual(snapshot.evaluation.target, {
      prediction_field: "expected_return",
      actual_field: "actual_return",
      error_field: "error",
      unit: "percentage_points",
      error_formula: "actual_return - expected_return",
    });
    assert.equal(snapshot.evaluation.sample_count, snapshot.rows.length);
    assert.equal(snapshot.evaluation.missing_sample_count, snapshot.evaluation.sample_count - snapshot.evaluation.evaluated_sample_count);
  }
  assert.equal(forecast.evaluation.status, "pending");
  assert.equal(forecast.evaluation.evaluated_sample_count, 0);
  assert.equal(forecast.evaluation.evaluation_range.actual_stage, null);
  assert.equal(settled.evaluation.status, "evaluated");
  assert.equal(settled.evaluation.evaluated_sample_count, settled.rows.length);
  assert.equal(settled.evaluation.evaluation_range.actual_stage, "0900");
  assert.equal(settled.evaluation.metrics.mean_absolute_error > 0, true);
  assert.equal(settled.meta.evaluation_test_only, true);
  assert.equal(source.rows.some((row) => typeof row.expected_return === "number" && !Number.isInteger(row.expected_return)), true);
  assert.deepEqual(source.rows.map((row) => row.expected_return), settled.rows.map((row) => row.expected_return));
});

test("historical-test evaluation cannot be accepted without test-only provenance", async () => {
  const snapshot = JSON.parse(await readFile(join(PROJECT_ROOT, "data", "runs", "historical-test", "2026-10-23", "1530.json"), "utf8"));
  const withoutEvaluation = { ...snapshot };
  delete withoutEvaluation.evaluation;
  assert.equal(isSnapshot(withoutEvaluation), false);
  assert.equal(isLiveNoDataSnapshot({
    schemaVersion: "1.0.0",
    mode: "provider",
    status: "no_data",
    provider: { id: null },
    meta: { isDemo: false, historical_test: false, test_only: false },
    evaluation: { test_only: true },
  }), false);
});

test("operating UI declares historical fallback as not live and reads only isolated run paths", async () => {
  const app = await readFile(join(PROJECT_ROOT, "app.js"), "utf8");
  assert.match(app, /TEST ONLY · HISTORICAL BASELINE · NOT LIVE/);
  assert.match(app, /isLiveNoDataSnapshot/);
  assert.match(app, /historical_fallback_source/);
  assert.match(app, /historicalTestRunPath/);
  assert.match(app, /historical-test-fallback\.js/);
  assert.doesNotMatch(app, /data\/historical-test\//);
});

test("operating UI tries the historical fallback before rejecting a no_data snapshot as test-only", async () => {
  const app = await readFile(join(PROJECT_ROOT, "app.js"), "utf8");
  const noDataBranch = app.indexOf('if (latest.status === "no_data")');
  const testOnlyBranch = app.indexOf("if (isTestOnly(latest))");
  assert.ok(noDataBranch >= 0);
  assert.ok(testOnlyBranch >= 0);
  assert.ok(noDataBranch < testOnlyBranch);
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
    const deterministicEnv = { ...process.env, KOSPI_RUN_STARTED_AT: "2026-10-23T00:00:00.000Z" };
    for (const mode of modes) await execFileAsync(process.execPath, [script, "--mode", mode, ...args], { cwd: tempRoot, env: deterministicEnv });

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
    for (const mode of modes) await execFileAsync(process.execPath, [script, "--mode", mode, ...args], { cwd: tempRoot, env: deterministicEnv });
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
      await execExpectNonReady(process.execPath, [script, "--mode", mode, "--provider", "none", "--run-date", "2026-10-23", "--data-file", dataFile], { cwd: PROJECT_ROOT });
      const observed = JSON.parse(await readFile(dataFile, "utf8"));
      assert.deepEqual(observed.rows[0], { ...row, error: 1 });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("independent settlement stages do not fall back to stale latest rows when the current run predecessor is missing", async () => {
  const tempRoot = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", "kospi-stale-stage-"));
  const script = join(PROJECT_ROOT, "scripts", "update-results.mjs");
  const stale = {
    schemaVersion: "1.0.0",
    status: "ready",
    mode: "provider",
    asOfDate: "2026-10-26",
    provider: { id: "stale-provider" },
    meta: { run_date: "2026-10-26", run_stage: "close-settlement" },
    pipeline: {},
    rows: [{
      rank: 1,
      symbol: "STALE",
      name: "이전 거래일 행",
      expected_open: 100,
      expected_close: null,
      expected_return: 0,
      actual_open: 101,
      actual_close: 102,
      actual_return: 1,
      session_return: 1,
      actual_volume: 10,
      error: 1,
      confidence: null,
      quality: "stale",
      status: "valid",
    }],
  };
  try {
    await mkdir(join(tempRoot, "data"), { recursive: true });
    await writeFile(join(tempRoot, "data", "latest-snapshot.json"), `${JSON.stringify(stale)}\n`, "utf8");
    for (const mode of ["open-settlement", "close-settlement"]) {
      await execExpectNonReady(process.execPath, [script, "--mode", mode, "--provider", "none", "--run-date", "2026-10-27"], { cwd: tempRoot });
      const stage = mode === "open-settlement" ? "0900" : "1530";
      const output = JSON.parse(await readFile(join(tempRoot, "data", "runs", "2026-10-27", `${stage}.json`), "utf8"));
      assert.equal(output.meta.run_date, "2026-10-27");
      assert.equal(output.status, "no_data");
      assert.deepEqual(output.rows, []);
      assert.equal(output.pipeline[mode === "open-settlement" ? "openSettlement" : "closeSettlement"].status, "blocked");
      await rm(join(tempRoot, "data", "runs", "2026-10-27"), { recursive: true, force: true });
      await writeFile(join(tempRoot, "data", "latest-snapshot.json"), `${JSON.stringify(stale)}\n`, "utf8");
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
      assert.equal(snapshots[3].rows.every((row) => row.actual_open !== null && row.session_return === null && row.actual_return === Math.round(((row.actual_open / row.prior_close - 1) * 100 + Number.EPSILON) * 100) / 100 && row.error === Math.round((row.actual_return - row.expected_return + Number.EPSILON) * 100) / 100), true);
      assert.equal(snapshots[4].rows.every((row) => row.actual_close !== null && row.session_return === (row.actual_open > 0 ? Math.round(((row.actual_close / row.actual_open - 1) * 100 + Number.EPSILON) * 100) / 100 : null) && row.actual_return === Math.round(((row.actual_open / row.prior_close - 1) * 100 + Number.EPSILON) * 100) / 100 && row.error === Math.round((row.actual_return - row.expected_return + Number.EPSILON) * 100) / 100), true);
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
    assert.equal(snapshot.rows.every((row) => row.session_return === (row.actual_open > 0 ? Math.round(((row.actual_close / row.actual_open - 1) * 100 + Number.EPSILON) * 100) / 100 : null)), true);
    assert.equal(snapshot.rows.every((row) => row.expected_close === null), true);
    assert.equal(snapshot.rows.every((row) => row.confidence === null), true);
    assert.equal(snapshot.rows.every((row) => ["historical_baseline_public_daily", "historical_baseline_public_daily_settled"].includes(row.quality)), true);
    assert.equal(snapshot.rows.some((row) => row.expected_return !== 0), true);
    assert.equal(snapshot.rows.every((row) => row.features && Number.isFinite(row.features.momentum) && Number.isFinite(row.features.volatility)), true);
    assert.equal(snapshot.rows.every((row) => Math.abs(row.actual_return - ((row.actual_open / row.prior_close - 1) * 100)) < 0.011), true);
    assert.equal(snapshot.rows.every((row) => row.session_return === (row.actual_open > 0 ? Math.round(((row.actual_close / row.actual_open - 1) * 100 + Number.EPSILON) * 100) / 100 : null)), true);
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

test("KR모터스 장중 수익률은 실제 시가에서 실제 종가로 계산한다", async () => {
  const snapshot = JSON.parse(await readFile(join(PROJECT_ROOT, "data", "runs", "historical-test", "2026-10-23", "1530.json"), "utf8"));
  const row = snapshot.rows.find((candidate) => candidate.symbol === "000040");
  assert.ok(row);
  assert.equal(row.actual_open, 1202);
  assert.equal(row.actual_close, 1165);
  assert.equal(row.actual_return, 2.56);
  assert.equal(row.session_return, -3.08);
  assert.equal(row.session_return, Math.round(((row.actual_close / row.actual_open - 1) * 100 + Number.EPSILON) * 100) / 100);
  assert.equal(row.error, Math.round((row.actual_return - row.expected_return + Number.EPSILON) * 100) / 100);
});

test("ranking views expose actual close whenever settlement data is present", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /actualClose: valueOf\(row, "actual_close"\)/);
  assert.match(app, /sessionReturn: valueOf\(row, "session_return"\)/);
  assert.match(app, /rowMetric\("실제 종가", formatPrice\(row\.actualClose\)\)/);
  assert.match(app, /rowMetric\("실제 수익률", formatPercent\(row\.sessionReturn/);
  assert.match(app, /rowMetric\("평가용 시가 수익률", formatPercent\(row\.actualReturn/);
  assert.match(app, /setText\(elementIds\["selected-actual-close"\], formatPrice\(row\.actualClose\)\)/);
  assert.match(app, /setText\(elementIds\["selected-actual-return"\], formatPercent\(row\.sessionReturn\)\)/);
  assert.match(app, /setText\(elementIds\["selected-evaluation-return"\], formatPercent\(row\.actualReturn\)\)/);
  assert.match(html, />실제 종가<\/th>/);
  assert.match(html, />실제 수익률<\/th>/);
  assert.match(html, />평가용 시가 수익률<\/th>/);
  assert.match(html, /id="selected-actual-close"/);
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

test("Naver crawl provider parses batched quotes and preserves freshness metadata", async () => {
  const now = new Date("2026-10-26T23:59:30.000Z");
  const response = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "content-type" ? "application/json" : null },
    text: async () => typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  const fetchImpl = async (url) => {
    if (url.includes("m.stock.naver.com")) return response({ totalCount: 2, stocks: [
      { itemCode: "000001", stockName: "첫종목", stockEndType: "stock", sosok: "0" },
      { itemCode: "000002", stockName: "둘종목", stockEndType: "stock", sosok: "0" },
    ] });
    assert.match(url, /polling\.finance\.naver\.com\/api\/realtime\/domestic\/stock\/000001,000002/);
    return response({ datas: [
      { symbolCode: "000001", stockName: "첫종목", openPriceRaw: "102", closePriceRaw: "100", compareToPreviousClosePriceRaw: "0", localTradedAt: "2026-10-27T08:59:25+09:00", marketStatus: "PREOPEN" },
      { symbolCode: "000002", stockName: "둘종목", openPriceRaw: "98", closePriceRaw: "100", compareToPreviousClosePriceRaw: "0", localTradedAt: "2026-10-27T08:59:20+09:00", marketStatus: "PREOPEN" },
    ] });
  };
  const provider = createNaverCrawlProvider({
    env: { KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0", KOSPI_RUN_ID: "test-crawl" },
    fetchImpl,
    now: () => now,
  });
  const result = await provider.generateForecast();
  assert.equal(resolveCrawlStage(now), "before-open");
  assert.equal(parseLocalTradedAt("2026-10-27T08:59:25+09:00").toISOString(), "2026-10-26T23:59:25.000Z");
  assert.equal(result.status, "ready");
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].expected_open, 102);
  assert.equal(result.rows[0].actual_open, null);
  assert.equal(result.rows[0].quote_at, "2026-10-26T23:59:25.000Z");
  assert.equal(result.rows[0].market_status, "PREOPEN");
  assert.equal(result.source.source_id, "naver-public-polling-crawl");
  assert.equal(result.source.license_status, "unconfirmed");
  assert.equal(result.source.metrics.quote_count, 2);
});

test("Naver crawl provider refuses synthesized pre-open values and stale quotes", async () => {
  const response = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "content-type" ? "application/json" : null },
    text: async () => typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  const now = new Date("2026-10-26T23:59:30.000Z");
  const makeProvider = (quote) => createNaverCrawlProvider({
    env: { KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0" },
    fetchImpl: async (url) => url.includes("m.stock.naver.com")
      ? response({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "종목", stockEndType: "stock", sosok: "0" }] })
      : response({ datas: [quote] }),
    now: () => now,
  });
  const noOpen = await makeProvider({ symbolCode: "000001", stockName: "종목", openPriceRaw: null, closePriceRaw: "100", localTradedAt: "2026-10-27T08:59:25+09:00", marketStatus: "PREOPEN" }).generateForecast();
  assert.equal(noOpen.status, "no_data");
  assert.equal(noOpen.rows.length, 0);
  assert.match(noOpen.message, /previous close|synthesi/i);

  const stale = await makeProvider({ symbolCode: "000001", stockName: "종목", openPriceRaw: "101", closePriceRaw: "100", localTradedAt: "2026-10-26T15:30:00+09:00", marketStatus: "CLOSE" }).generateForecast();
  assert.equal(stale.status, "degraded");
  assert.equal(stale.rows.length, 0);
  assert.equal(stale.source.status, "stale");
});

test("Naver crawl provider maps open and close stages to actual fields", async () => {
  const response = (payload) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(payload) });
  const makeProvider = (now, quote) => createNaverCrawlProvider({
    env: { KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0" },
    fetchImpl: async (url) => url.includes("m.stock.naver.com")
      ? response({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "종목", stockEndType: "stock", sosok: "0" }] })
      : response({ datas: [quote] }),
    now: () => now,
  });
  const open = await makeProvider(new Date("2026-10-27T01:00:00.000Z"), { symbolCode: "000001", stockName: "종목", openPriceRaw: "101", closePriceRaw: "102", compareToPreviousClosePriceRaw: "2", localTradedAt: "2026-10-27T10:00:00+09:00", marketStatus: "OPEN" }).settleOpen();
  assert.equal(open.status, "ready");
  assert.equal(open.rows[0].actual_open, 101);
  assert.equal(open.rows[0].actual_close, null);
  assert.equal(open.rows[0].actual_return, 1);

  const close = await makeProvider(new Date("2026-10-27T08:00:00.000Z"), { symbolCode: "000001", stockName: "종목", openPriceRaw: "101", closePriceRaw: "103", compareToPreviousClosePriceRaw: "2", localTradedAt: "2026-10-27T15:30:00+09:00", marketStatus: "CLOSE" }).settleClose();
  assert.equal(close.status, "ready");
  assert.equal(close.rows[0].actual_open, 101);
  assert.equal(close.rows[0].actual_close, 103);
  assert.equal(close.rows[0].session_return, 1.98);
});

test("Naver crawl provider stops on 403, 429, and empty responses", async () => {
  const response = (payload, status) => ({ ok: false, status, headers: { get: () => "application/json" }, text: async () => payload });
  for (const status of [403, 429]) {
    const provider = createNaverCrawlProvider({
      env: { KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "2" },
      fetchImpl: async () => response(status === 403 ? "Forbidden" : "Too many requests", status),
      now: () => new Date("2026-10-26T23:59:30.000Z"),
    });
    const result = await provider.generateForecast();
    assert.equal(result.status, "blocked");
    assert.equal(result.source.metrics.requested, 1);
  }
  const empty = createNaverCrawlProvider({
    env: { KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0" },
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ totalCount: 0, stocks: [] }) }),
    now: () => new Date("2026-10-26T23:59:30.000Z"),
  });
  const emptyResult = await empty.generateForecast();
  assert.equal(emptyResult.status, "no_data");
  assert.equal(emptyResult.rows.length, 0);
});

test("resolveProvider registers naver-crawl with the caller run context and preserves its unconfirmed source policy", async () => {
  const runStartedAt = "2026-10-26T23:59:30.000Z";
  const attemptedAt = "2026-10-26T23:59:30.000Z";
  const response = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(payload),
  });
  const { provider, providerId } = resolveProvider({}, {
    provider: "naver-crawl",
    mode: "forecast",
    runDate: "2026-10-27",
    runStartedAt,
    attemptedAt,
    fetchImpl: async (url) => url.includes("m.stock.naver.com")
      ? response({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "종목", stockEndType: "stock", sosok: "0" }] })
      : response({ datas: [{ symbolCode: "000001", stockName: "종목", openPriceRaw: "101", closePriceRaw: "102", compareToPreviousClosePriceRaw: "2", localTradedAt: "2026-10-27T08:59:25+09:00", marketStatus: "PREOPEN" }] }),
  });
  assert.equal(providerId, "naver-crawl");
  assert.equal(provider.id, "naver-crawl");
  assert.equal(provider.getSourceMetadata().license_status, "unconfirmed");

  const result = await provider.generateForecast();
  assert.equal(result.status, "ready");
  assert.equal(result.rows.length, 1);
  assert.equal(result.source.license_status, "unconfirmed");
  assert.equal(result.source.retrieved_at, attemptedAt);
  assert.equal(result.source.run_id, "2026-10-27-forecast");
});

test("operating naver-crawl run keeps live rows but degrades the ready gate when licensing is unconfirmed", async () => {
  const previousFetch = globalThis.fetch;
  const response = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(payload),
  });
  globalThis.fetch = async (url) => url.includes("m.stock.naver.com")
    ? response({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "종목", stockEndType: "stock", sosok: "0" }] })
    : response({ datas: [{ symbolCode: "000001", stockName: "종목", openPriceRaw: "101", closePriceRaw: "102", compareToPreviousClosePriceRaw: "2", localTradedAt: "2026-10-27T08:59:25+09:00", marketStatus: "PREOPEN" }] });
  try {
    const summary = await runStage([
      "--mode", "forecast",
      "--provider", "naver-crawl",
      "--run-date", "2026-10-27",
      "--run-started-at", "2026-10-26T23:59:30.000Z",
      "--attempted-at", "2026-10-26T23:59:30.000Z",
      "--dry-run",
    ]);
    assert.equal(summary.provider, "naver-crawl");
    assert.equal(summary.status, "degraded");
    assert.match(summary.message, /licensing is confirmed/i);
  } finally {
    globalThis.fetch = previousFetch;
  }
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
  assert.equal(observed.rows.every((row) => row.session_return === 10), true);
  assert.equal(observed.rows.every((row) => row.actual_close === 110 || row.actual_close === 220), true);
  assert.equal(observed.source.source_id, "aikstockdata-public-daily-csv");
  assert.equal(observed.source.run_id, "test-run");
  assert.equal(observed.source.metrics.max_concurrency, 2);
  assert.equal(observed.source.metrics.requested, calls.length);

  const forecast = await provider.generateForecast();
  assert.equal(forecast.status, "no_data");
  assert.equal(forecast.rows.length, 0);
  assert.equal(forecast.asOfDate, "2026-10-23");
  assert.equal(forecast.source.source_date, "2026-10-23");
  assert.match(forecast.message, /unsupported|pre-market|order book/i);
  const openSettlement = await provider.settleOpen();
  assert.equal(openSettlement.status, "no_data");
  assert.match(openSettlement.message, /09:00|actual_open|no_data/i);
});

test("public CSV forecast rejects an old source as degraded and keeps its source date", async () => {
  const csv = [
    "basDt,mrktCtg,종목코드,종목명,mkp,clpr,trqu",
    "20261023,KOSPI,000001,공개종목,100,110,1000",
  ].join("\n");
  const fetchImpl = async (url) => {
    const date = url.match(/quotes_(\d{8})\.csv/)?.[1];
    if (date === "20261023") return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "text/csv" : null }, text: async () => csv };
    return { ok: false, status: 404, headers: { get: () => "text/plain" }, text: async () => "not found" };
  };
  const provider = createPublicCsvProvider({
    env: { KOSPI_PUBLIC_MAX_RETRIES: "0" },
    fetchImpl,
    now: () => new Date("2026-10-27T23:10:00.000Z"),
  });
  const forecast = await provider.generateForecast();
  assert.equal(forecast.status, "degraded");
  assert.equal(forecast.rows.length, 0);
  assert.equal(forecast.asOfDate, "2026-10-23");
  assert.equal(forecast.source.source_date, "2026-10-23");
  assert.equal(forecast.source.status, "stale");
  assert.match(forecast.message, /stale/i);
});

test("manual and scheduled runs share the GitHub run-start reference time", async () => {
  const context = calculateRunContext("2026-10-27T00:15:00.000Z");
  assert.equal(context.runDate, "2026-10-27");
  assert.equal(context.referenceTime, "2026-10-27T00:15:00.000Z");

  const previous = process.env.KOSPI_RUN_STARTED_AT;
  process.env.KOSPI_RUN_STARTED_AT = "2026-10-27T00:15:00.000Z";
  try {
    const summary = await runStage(["--mode", "forecast", "--provider", "none", "--dry-run"]);
    assert.equal(summary.runDate, "2026-10-27");
    assert.equal(summary.attemptedAt, "2026-10-27T00:15:00.000Z");
    assert.equal(summary.referenceTime, summary.attemptedAt);
    assert.equal(summary.status, "no_data");
  } finally {
    if (previous === undefined) delete process.env.KOSPI_RUN_STARTED_AT;
    else process.env.KOSPI_RUN_STARTED_AT = previous;
  }
});

test("an omitted run-start reference uses the current execution time, never the Unix epoch", () => {
  const previous = process.env.KOSPI_RUN_STARTED_AT;
  delete process.env.KOSPI_RUN_STARTED_AT;
  try {
    const context = calculateRunContext();
    assert.notEqual(context.referenceTime, "1970-01-01T00:00:00.000Z");
    assert.ok(Date.parse(context.referenceTime) > Date.parse("2026-01-01T00:00:00.000Z"));
  } finally {
    if (previous === undefined) delete process.env.KOSPI_RUN_STARTED_AT;
    else process.env.KOSPI_RUN_STARTED_AT = previous;
  }
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
