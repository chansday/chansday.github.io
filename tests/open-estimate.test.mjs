import test from "node:test";
import assert from "node:assert/strict";
import { createNaverCrawlProvider, historicalOpenEstimate } from "../providers/naver-crawl-provider.js";
import { mergeRows } from "../scripts/update-results.mjs";
import { mergePostCloseEvaluation } from "../providers/post-close-overlay.js";

const respond = (payload, type = "application/json", status = 200) => ({ ok: status === 200, status, headers: { get: () => type }, text: async () => typeof payload === "string" ? payload : JSON.stringify(payload) });
function makeProvider(time, { missing = false, preopen = false } = {}) {
  const now = new Date(time); const dates = { 20261026: [110, 120], 20261023: [100, 100], 20261022: [90, 95] };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/marketValue")) return respond({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "A", stockEndType: "stock", sosok: "0" }] });
    if (url.includes("polling.finance")) return respond({ datas: [{ symbolCode: "000001", stockName: "A", openPriceRaw: preopen ? 125 : 130, closePriceRaw: 150, compareToPreviousClosePriceRaw: 30, localTradedAt: new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 19) + "+09:00", marketStatus: preopen ? "PREOPEN" : "OPEN" }] });
    if (url.endsWith("/robots.txt")) return respond("User-agent: *\nAllow: /\n", "text/plain");
    const date = url.match(/quotes_(\d{8})/)?.[1];
    if (!dates[date] || missing) return respond("", "text/plain", 404);
    const [open, close] = dates[date]; return respond(`basDt,종목코드,종목명,mrktCtg,mkp,clpr,trqu\n${date},000001,A,KOSPI,${open},${close},1000\n`, "text/csv");
  };
  const provider = createNaverCrawlProvider(withNaverRobots({ env: { KOSPI_MANUAL_RUN_ALL: "1", KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0", KOSPI_PUBLIC_MAX_RETRIES: "0" }, now: () => now, runStartedAt: now.toISOString(), fetchImpl }));
  return { provider, calls };
}

test("pre-open quote is recorded and intraday retains it instead of current or actual price", async () => {
  const early = makeProvider("2026-10-26T23:20:00Z", { preopen: true });
  const first = await early.provider.generateForecast();
  assert.equal(first.rows[0].expected_open, 125);
  assert.equal(first.rows[0].expected_open_source.kind, "preopen_quote");
  const later = makeProvider("2026-10-27T04:11:00Z");
  const current = await later.provider.generateForecast({ snapshot: { asOfDate: "2026-10-27", rows: first.rows } });
  assert.equal(current.rows[0].expected_open, 125);
  assert.equal(current.rows[0].expected_open_source.kind, "preopen_quote");
  assert.ok(!later.calls.some((u) => u.includes("aikstockdata")));
  for (const stage of ["forecast", "open-settlement", "close-settlement"]) assert.equal(mergeRows(first.rows, current.rows, stage)[0].expected_open, 125);
});

test("history estimate before open and retrospective intraday use only prior dates", async () => {
  for (const [time, kind] of [["2026-10-26T23:20:00Z", "preopen_history"], ["2026-10-27T04:11:00Z", "retrospective_history"], ["2026-10-27T07:00:00Z", "retrospective_history"]]) {
    const { provider, calls } = makeProvider(time);
    const result = await provider.generateForecast();
    assert.equal(result.status, "ready");
    assert.equal(result.rows[0].expected_open, 120);
    assert.equal(result.rows[0].expected_open_source.kind, kind);
    assert.deepEqual(result.rows[0].expected_open_source.history_dates, ["2026-10-26", "2026-10-23", "2026-10-22"]);
    assert.ok(!calls.some((u) => u.includes("quotes_20261027")));
    assert.notEqual(result.rows[0].expected_open, 130); assert.notEqual(result.rows[0].expected_open, 150);
  }
});

test("missing history never becomes the observed open or current quote", async () => {
  const { provider } = makeProvider("2026-10-27T04:11:00Z", { missing: true });
  const result = await provider.generateForecast();
  assert.equal(result.status, "degraded"); assert.equal(result.rows[0].expected_open, null);
  assert.match(result.message, /HTTP 404/); assert.equal(result.source.metrics.history_status, "degraded");
  assert.equal(historicalOpenEstimate([], "000001"), null);
});

test("post-close overlay does not overwrite an existing opening record", () => {
  const src = { kind: "preopen_quote", recorded_at: "2026-10-26T23:20:00Z", history_dates: [] };
  const row = { symbol: "000001", expected_open: 125, expected_open_source: src, expected_close: null, actual_open: 130, actual_close: 150 };
  const snapshot = { status: "ready", meta: { run_date: "2026-10-27", run_id: "1", run_stage: "close-settlement" }, rows: [row] };
  const record = { schema_version: 1, kind: "post_close_retrospective", run_date: "2026-10-27", run_id: "1", history_dates: ["2026-10-26", "2026-10-23", "2026-10-22"], rows: [{ symbol: "000001", actual_open: 130, actual_close: 150, expected_open: 120, expected_close: 130 }] };
  const merged = mergePostCloseEvaluation(snapshot, record).rows[0];
  assert.equal(merged.expected_open, 125); assert.equal(merged.expected_close, null); assert.deepEqual(merged.expected_open_source, src);
});
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../scripts/update-results.mjs";
import { noDataSnapshot } from "../providers/provider-adapter.js";

test("settlement recovers an earlier same-day pre-open quote when intermediate stages are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "kospi-open-recovery-")); const original = process.cwd();
  const now = new Date("2026-10-27T04:11:00Z");
  const source = { kind: "preopen_quote", recorded_at: "2026-10-26T23:20:00Z", history_dates: [] };
  const row = { rank: 1, symbol: "000001", name: "A", expected_open: 125, expected_open_source: source, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, error: null, status: "valid" };
  try {
    await mkdir(join(root, "data", "runs", "2026-10-27"), { recursive: true });
    const prior = { ...noDataSnapshot(), status: "ready", mode: "provider", asOfDate: "2026-10-27", provider: { id: "naver-crawl" }, rows: [row], meta: { run_date: "2026-10-27", run_stage: "forecast" } };
    await writeFile(join(root, "data", "runs", "2026-10-27", "0820.json"), JSON.stringify(prior));
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const fetchImpl = async (url) => url.includes("/marketValue") ? respond({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "A", stockEndType: "stock", sosok: "0" }] }) : respond({ datas: [{ symbolCode: "000001", stockName: "A", openPriceRaw: 130, closePriceRaw: 150, localTradedAt: "2026-10-27T13:11:00+09:00", marketStatus: "OPEN" }] });
    const summary = await run(["--mode", "open-settlement", "--provider", "naver-crawl", "--run-date", "2026-10-27", "--run-started-at", now.toISOString()], { now: () => now, fetchImpl: naverRobotsFetch(fetchImpl) });
    assert.equal(summary.status, "ready");
    const saved = JSON.parse(await readFile(join(root, "data", "runs", "2026-10-27", "0900.json"), "utf8"));
    assert.equal(saved.rows[0].expected_open, 125); assert.equal(saved.rows[0].actual_open, 130); assert.deepEqual(saved.rows[0].expected_open_source, source);
    const unchanged = JSON.parse(await readFile(join(root, "data", "runs", "2026-10-27", "0820.json"), "utf8")); assert.equal(unchanged.rows[0].expected_open, 125);
  } finally { process.chdir(original); delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
});
import { isRankingRow } from "../providers/provider-adapter.js";

test("provider rejects a saved pre-open record newer than the execution time", async () => {
  const { provider } = makeProvider("2026-10-26T23:20:00Z", { preopen: true });
  const future = { symbol: "000001", expected_open: 999, expected_open_source: { kind: "preopen_quote", recorded_at: "2026-10-26T23:40:00Z", history_dates: [] } };
  const result = await provider.generateForecast({ snapshot: { asOfDate: "2026-10-27", rows: [future] } });
  assert.equal(result.rows[0].expected_open, 125);
  assert.equal(result.rows[0].expected_open_source.recorded_at, "2026-10-26T23:20:00.000Z");
});

test("stage recovery and merge reject a later pre-open snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "kospi-future-recovery-")); const original = process.cwd();
  const now = new Date("2026-10-26T23:20:00Z");
  const row = { rank: 1, symbol: "000001", name: "A", expected_open: 999, expected_open_source: { kind: "preopen_quote", recorded_at: "2026-10-26T23:40:00Z", history_dates: [] }, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, error: null, status: "valid" };
  try {
    await mkdir(join(root, "data", "runs", "2026-10-27"), { recursive: true });
    const prior = { ...noDataSnapshot(), status: "ready", mode: "provider", asOfDate: "2026-10-27", provider: { id: "naver-crawl" }, rows: [row], meta: { run_date: "2026-10-27", run_stage: "forecast" } };
    await writeFile(join(root, "data", "runs", "2026-10-27", "0820.json"), JSON.stringify(prior));
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const fetchImpl = async (url) => url.includes("/marketValue") ? respond({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "A", stockEndType: "stock", sosok: "0" }] }) : respond({ datas: [{ symbolCode: "000001", stockName: "A", openPriceRaw: 125, closePriceRaw: 120, localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN" }] });
    const summary = await run(["--mode", "forecast", "--provider", "naver-crawl", "--run-date", "2026-10-27", "--run-started-at", now.toISOString()], { now: () => now, fetchImpl: naverRobotsFetch(fetchImpl) });
    assert.equal(summary.status, "ready");
    const saved = JSON.parse(await readFile(join(root, "data", "runs", "2026-10-27", "0820.json"), "utf8"));
    assert.equal(saved.rows[0].expected_open, 125); assert.notEqual(saved.rows[0].expected_open, 999);
  } finally { process.chdir(original); delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
});

test("mixed post-close overlay keeps recorded rows and fills and labels missing rows individually", async () => {
  const source = { kind: "preopen_quote", recorded_at: "2026-10-26T23:20:00Z", history_dates: [] };
  const date = ["2026-10-26", "2026-10-23", "2026-10-22"];
  const rows = [{ symbol: "000001", expected_open: 125, expected_open_source: source, expected_close: null, actual_open: 130, actual_close: 150 }, { symbol: "000002", expected_open: null, expected_close: null, actual_open: 50, actual_close: 55 }];
  const record = { schema_version: 1, kind: "post_close_retrospective", run_date: "2026-10-27", run_id: "1", history_dates: date, rows: [{ symbol: "000001", expected_open: 120, expected_close: 130, actual_open: 130, actual_close: 150 }, { symbol: "000002", expected_open: 48, expected_close: 51, actual_open: 50, actual_close: 55 }] };
  const out = mergePostCloseEvaluation({ status: "ready", meta: { run_date: "2026-10-27", run_id: "1", run_stage: "close-settlement" }, rows }, record);
  assert.equal(out.rows[0].expected_open, 125); assert.equal(out.rows[0].expected_close, null);
  assert.equal(out.rows[1].expected_open, 48); assert.deepEqual(out.rows[1].retrospective_overlay, date); assert.equal(out.meta.retrospective_mixed, true);
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /rows\?\.some\(\(row\) => row\.expected_open_source\)\) return/);
  assert.match(app, /retrospective_overlay/);
});

test("schema and provider agree on source-specific history counts and positive prices", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/market-snapshot.schema.json", import.meta.url), "utf8"));
  const condition = schema.$defs.rankingRow.allOf.find((entry) => entry.if?.required?.includes("expected_open_source"));
  const priceSchema = condition.then.properties.expected_open;
  const choice = condition.then.properties.expected_open_source.allOf[0];
  const row = { rank: 1, symbol: "000001", name: "A", expected_open: 100, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, error: null, status: "valid" };
  // Exercise the conditional constraints read from the JSON Schema itself.
  const schemaAccepts = (value) => {
    const src = value.expected_open_source; const dates = src.kind === choice.if.properties.kind.const ? choice.then.properties.history_dates : choice.else.properties.history_dates;
    return typeof value.expected_open === priceSchema.type && value.expected_open > priceSchema.exclusiveMinimum && src.history_dates.length >= (dates.minItems ?? 0) && src.history_dates.length <= (dates.maxItems ?? Infinity);
  };
  for (const [kind, dates, price, valid] of [["preopen_quote", [], 100, true], ["preopen_quote", ["2026-10-26"], 100, false], ["preopen_history", ["2026-10-26", "2026-10-23", "2026-10-22"], 100, true], ["retrospective_history", [], 100, false], ["retrospective_history", ["2026-10-26", "2026-10-23", "2026-10-22"], 0, false], ["preopen_quote", [], null, false]]) {
    const candidate = { ...row, expected_open: price, expected_open_source: { kind, recorded_at: "2026-10-26T23:20:00Z", history_dates: dates } };
    assert.equal(schemaAccepts(candidate), valid); assert.equal(isRankingRow(candidate), valid);
  }
});

test("history robots denial and HTTP errors remain visible for mixed quotes and settlement", async () => {
  for (const [failure, phase, method, expected, reason] of [["robots", "2026-10-26T23:20:00Z", "generateForecast", "blocked", /robots disallows/i], ["http", "2026-10-27T04:11:00Z", "settleOpen", "ready", /HTTP 500/i]]) {
    const now = new Date(phase); const quoteAt = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 19) + "+09:00";
    const fetchImpl = async (url) => {
      if (url.includes("/marketValue")) return respond({ totalCount: 2, stocks: ["000001", "000002"].map((itemCode) => ({ itemCode, stockName: itemCode, stockEndType: "stock", sosok: "0" })) });
      if (url.includes("polling.finance")) return respond({ datas: ["000001", "000002"].map((symbolCode, index) => ({ symbolCode, stockName: symbolCode, openPriceRaw: index === 0 || method === "settleOpen" ? 100 : null, closePriceRaw: 110, localTradedAt: quoteAt, marketStatus: method === "settleOpen" ? "OPEN" : "PREOPEN" })) });
      if (url.endsWith("robots.txt")) return respond(`User-agent: *\n${failure === "robots" ? "Disallow" : "Allow"}: /\n`, "text/plain");
      return respond("", "text/plain", 500);
    };
    const provider = createNaverCrawlProvider(withNaverRobots({ env: { KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0", KOSPI_PUBLIC_MAX_RETRIES: "0" }, now: () => now, runStartedAt: now.toISOString(), fetchImpl }));
    const result = await provider[method]();
    // Forecast fails on the history error; settlement keeps it as a visible warning only.
    assert.equal(result.status, expected); assert.equal(result.source.status, expected); assert.equal(result.source.metrics.history_status, failure === "robots" ? "blocked" : "degraded");
    assert.match(result.message, reason); assert.match(result.source.metrics.history_reason, reason);
    assert.equal(result.source.metrics.history_source, "https://aikstockdata.com/data/public/daily");
    if (failure === "robots") { assert.equal(result.rows[0].expected_open, 100); assert.equal(result.rows[1].expected_open, null); }
    else { assert.equal(result.rows[0].actual_open, 100); assert.equal(result.rows[0].expected_open, null); assert.equal(result.rows[1].expected_open, null); }
  }
});

test("runner records settlement prices while persisting blocked history provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "kospi-history-status-")); const original = process.cwd();
  const now = new Date("2026-10-27T04:11:00Z");
  try {
    await mkdir(join(root, "data"), { recursive: true });
    // The public-history collector reads the project calendar from its own module path.
    process.chdir(root); process.env.KOSPI_DATA_ROOT = root;
    const fetchImpl = async (url) => {
      if (url.includes("/marketValue")) return respond({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "A", stockEndType: "stock", sosok: "0" }] });
      if (url.includes("polling.finance")) return respond({ datas: [{ symbolCode: "000001", stockName: "A", openPriceRaw: 130, closePriceRaw: 150, localTradedAt: "2026-10-27T13:11:00+09:00", marketStatus: "OPEN" }] });
      if (url.endsWith("robots.txt")) return respond("User-agent: *\nDisallow: /\n", "text/plain");
      throw new Error("unexpected history request");
    };
    const summary = await run(["--mode", "open-settlement", "--provider", "naver-crawl", "--run-date", "2026-10-27", "--run-started-at", now.toISOString()], { now: () => now, fetchImpl: naverRobotsFetch(fetchImpl) });
    assert.equal(summary.status, "ready");
    const saved = JSON.parse(await readFile(join(root, "data", "runs", "2026-10-27", "0900.json"), "utf8"));
    assert.equal(saved.rows[0].actual_open, 130); assert.equal(saved.rows[0].expected_open, null);
    assert.equal(saved.meta.source.metrics.history_status, "blocked"); assert.match(saved.meta.source.metrics.history_reason, /robots disallows/i);
    assert.match(saved.pipeline.openSettlement.message, /robots disallows/i);
  } finally { process.chdir(original); delete process.env.KOSPI_DATA_ROOT; await rm(root, { recursive: true, force: true }); }
});
import { runInNewContext } from "node:vm";
import { buildEvaluationSummary } from "../providers/evaluation-contract.js";
import { naverRobotsFetch, withNaverRobots } from "./naver-robots-helper.mjs";

test("same-run and future opening records stay bounded", async () => {
  const started = "2026-10-26T23:20:00.000Z", date = "2026-10-27", current = new Date("2026-10-26T23:20:30Z");
  const fetchImpl = async (url) => url.includes("/marketValue") ? respond({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "A", stockEndType: "stock", sosok: "0" }] }) : respond({ datas: [{ symbolCode: "000001", stockName: "A", openPriceRaw: 125, closePriceRaw: 110, localTradedAt: "2026-10-27T08:20:30+09:00", marketStatus: "PREOPEN" }] });
  const provider = createNaverCrawlProvider(withNaverRobots({ env: { KOSPI_RUN_ID: "same-run.1", KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0" }, now: () => current, runStartedAt: started, fetchImpl }));
  const source = { kind: "preopen_quote", recorded_at: "2026-10-26T23:20:10.000Z", history_dates: [] };
  const saved = { symbol: "000001", expected_open: 123, expected_open_source: source };
  const same = await provider.generateForecast({ snapshot: { asOfDate: date, meta: { run_id: "same-run.1" }, rows: [saved] } });
  assert.equal(same.status, "ready"); assert.equal(same.rows[0].expected_open, 123);
  const other = await provider.generateForecast({ snapshot: { asOfDate: date, meta: { run_id: "other" }, rows: [saved] } });
  assert.equal(other.rows[0].expected_open, 125);
  const future = { ...saved, expected_open: 999, expected_open_source: { ...source, recorded_at: "2026-10-26T23:20:50.000Z" } };
  assert.equal((await provider.generateForecast({ snapshot: { asOfDate: date, meta: { run_id: "same-run.1" }, rows: [future] } })).rows[0].expected_open, 125);
});

test("post-close record is loaded for recorded rows and the screen summary matches displayed values", async () => {
  const src = { kind: "preopen_quote", recorded_at: "2026-10-26T23:20:00Z", history_dates: [] };
  const snapshot = { status: "ready", meta: { run_date: "2026-10-27", run_id: "1", run_stage: "close-settlement" }, rows: [{ symbol: "000001", expected_open: 125, expected_open_source: src, expected_close: null, actual_open: 130, actual_close: 150 }] };
  const rows = [{ symbol: "000001", expected_open: 120, expected_close: 130, actual_open: 130, actual_close: 150, error: 6.55 }];
  const evaluation = buildEvaluationSummary(rows, { testOnly: true, dataset: "historical_test", asOfDate: "2026-10-27", forecastStage: "0820", actualStage: "1530", inputDates: ["2026-10-22", "2026-10-23", "2026-10-26"] });
  const record = { schema_version: 1, kind: "post_close_retrospective", run_date: "2026-10-27", run_id: "1", history_dates: ["2026-10-26", "2026-10-23", "2026-10-22"], rows, evaluation };
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const code = app.slice(app.indexOf("async function renderPostClose"), app.indexOf("function setText"));
  let rendered = null, requests = 0;
  const context = { postCloseToken: 0, isIsoDate: () => true, isTestOnly: () => false, fetch: async () => { requests++; return { status: 200, ok: true, json: async () => record }; }, mergePostCloseEvaluation, renderHeader: (data) => { rendered = data; }, setText: () => {}, elementIds: {} };
  await runInNewContext(`${code}; renderPostClose(input)`, { ...context, input: snapshot });
  assert.equal(requests, 1); assert.equal(rendered.rows[0].expected_open, 125);
  assert.equal(rendered.rows[0].error, null); assert.equal(rendered.evaluation.evaluated_sample_count, 0);
  assert.equal(rendered.evaluation.metrics.mean_absolute_error, null);
  assert.equal(record.evaluation.evaluated_sample_count, 1); // Stored record is untouched.
});

test("blocked and degraded reruns leave existing latest and stage files byte-for-byte unchanged", async () => {
  for (const failure of ["blocked", "degraded"]) {
    const root = await mkdtemp(join(tmpdir(), "kospi-preserve-failure-")); const original = process.cwd(); const oldManual = process.env.KOSPI_MANUAL_RUN_ALL;
    const now = new Date("2026-10-27T04:11:00Z"), dir = join(root, "data", "runs", "2026-10-27");
    try {
      await mkdir(dir, { recursive: true });
      const stagePath = join(dir, "0820.json"), latestPath = join(root, "data", "latest-snapshot.json");
      const existing = { ...noDataSnapshot(), status: "ready", mode: "provider", asOfDate: "2026-10-27", provider: { id: "naver-crawl" }, rows: [{ rank: 1, symbol: "000001", name: "A", expected_open: null, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, error: null, status: "valid" }], meta: { run_date: "2026-10-27", run_stage: "forecast" } };
      const stageBytes = JSON.stringify(existing, null, 1) + "\n", latestBytes = "existing latest bytes\n";
      await writeFile(stagePath, stageBytes); await writeFile(latestPath, latestBytes); process.chdir(root); process.env.KOSPI_DATA_ROOT = root; process.env.KOSPI_MANUAL_RUN_ALL = "1";
      const fetchImpl = async (url) => {
        if (url.includes("/marketValue")) return respond({ totalCount: 1, stocks: [{ itemCode: "000001", stockName: "A", stockEndType: "stock", sosok: "0" }] });
        if (url.includes("polling.finance")) return respond({ datas: [{ symbolCode: "000001", stockName: "A", openPriceRaw: 130, closePriceRaw: 150, localTradedAt: "2026-10-27T13:11:00+09:00", marketStatus: "OPEN" }] });
        if (url.endsWith("robots.txt")) return respond(`User-agent: *\n${failure === "blocked" ? "Disallow" : "Allow"}: /\n`, "text/plain");
        return respond("", "text/plain", 404);
      };
      const result = await run(["--mode", "forecast", "--provider", "naver-crawl", "--run-date", "2026-10-27", "--run-started-at", now.toISOString()], { now: () => now, fetchImpl: naverRobotsFetch(fetchImpl) });
      assert.equal(result.status, failure); assert.equal(result.wroteRunFile, false); assert.equal(result.wroteLatestFile, false);
      assert.equal(result.source.metrics.history_status, failure); assert.match(result.message, failure === "blocked" ? /robots disallows/i : /HTTP 404/i);
      assert.equal(await readFile(stagePath, "utf8"), stageBytes); assert.equal(await readFile(latestPath, "utf8"), latestBytes);
      const explicit = await run(["--mode", "forecast", "--provider", "naver-crawl", "--run-date", "2026-10-27", "--run-started-at", now.toISOString(), "--data-file", stagePath], { now: () => now, fetchImpl: naverRobotsFetch(fetchImpl) });
      assert.equal(explicit.status, failure); assert.equal(explicit.wroteLatestFile, false); assert.equal(await readFile(stagePath, "utf8"), stageBytes);
    } finally { process.chdir(original); delete process.env.KOSPI_DATA_ROOT; if (oldManual === undefined) delete process.env.KOSPI_MANUAL_RUN_ALL; else process.env.KOSPI_MANUAL_RUN_ALL = oldManual; await rm(root, { recursive: true, force: true }); }
  }
});


test("mixed displayed rows determine summary counts and error metrics, not stored retrospective rows", () => {
  const source = { kind: "preopen_quote", recorded_at: "2026-10-26T23:20:00Z", history_dates: [] };
  const history = ["2026-10-26", "2026-10-23", "2026-10-22"];
  const snapshot = { status: "ready", meta: { run_date: "2026-10-27", run_id: "1", run_stage: "close-settlement" }, rows: [
    { symbol: "000001", expected_open: 100, expected_open_source: source, expected_close: 110, actual_open: 100, actual_close: 120 },
    { symbol: "000002", expected_open: null, expected_close: null, actual_open: 100, actual_close: 110 },
    { symbol: "000003", expected_open: 100, expected_open_source: source, expected_close: null, actual_open: 100, actual_close: 110 },
  ] };
  const recordRows = [
    { symbol: "000001", expected_open: 100, expected_close: 120, actual_open: 100, actual_close: 120, error: 0 },
    { symbol: "000002", expected_open: 100, expected_close: 105, actual_open: 100, actual_close: 110, error: 5 },
    { symbol: "000003", expected_open: 100, expected_close: 110, actual_open: 100, actual_close: 110, error: 0 },
  ];
  const stored = buildEvaluationSummary(recordRows, { testOnly: true, dataset: "historical_test", asOfDate: "2026-10-27", forecastStage: "0820", actualStage: "1530", inputDates: [...history].reverse() });
  const record = { schema_version: 1, kind: "post_close_retrospective", run_date: "2026-10-27", run_id: "1", history_dates: history, rows: recordRows, evaluation: stored };
  const result = mergePostCloseEvaluation(snapshot, record);
  assert.deepEqual(result.rows.map((row) => row.error), [10, 5, null]);
  assert.equal(result.evaluation.sample_count, 3);
  assert.equal(result.evaluation.evaluated_sample_count, 2);
  assert.equal(result.evaluation.missing_sample_count, 1);
  assert.equal(result.evaluation.metrics.mean_absolute_error, 7.5);
  assert.equal(result.evaluation.metrics.root_mean_squared_error, 7.9057);
  assert.equal(record.evaluation.evaluated_sample_count, 3);
  assert.equal(record.evaluation.metrics.mean_absolute_error, 1.6667);
});
