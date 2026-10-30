import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOSE_SESSION_MODEL, OPEN_GAP_MODEL, PREOPEN_QUOTE_MODEL, isCloseBasis, priorHistoryEstimate } from "../providers/forecast-basis.js";
import { withLegacyThreeSessionClose } from "./support/legacy-close-basis.mjs";
import { isRankingRow } from "../providers/provider-adapter.js";
import { buildPostCloseRows } from "../scripts/post-close-evaluation.mjs";
import { run } from "../scripts/update-results.mjs";
import { naverRobotsFetch } from "./naver-robots-helper.mjs";

// Newest first; never includes the target date 2026-10-27.
const bar = (date, open, close) => ({ symbol: "005930", date, open, high: Math.max(open, close) + 5, low: Math.min(open, close) - 5, close, volume: 1000 });
const SESSIONS = [
  { date: "2026-10-26", rows: [bar("2026-10-26", 102, 104)] },
  { date: "2026-10-23", rows: [bar("2026-10-23", 99, 101)] },
  { date: "2026-10-22", rows: [bar("2026-10-22", 100, 98)] },
];

test("prior-history estimate stores exactly the inputs it used and reproduces both values", () => {
  const e = priorHistoryEstimate(SESSIONS, "005930");
  // No rank model: the opening is estimated and no substitute close model runs.
  assert.equal(e.expected_open, 105.05); assert.equal(e.expected_close, null); assert.equal(e.close_basis, null);
  const legacy = withLegacyThreeSessionClose(e, SESSIONS, "005930");
  assert.equal(legacy.expected_close, 105.74, "retired 3-session fixture reproduces committed values");
  assert.equal(isCloseBasis(legacy.close_basis, { expected_open: legacy.expected_open, expected_close: legacy.expected_close, expected_open_basis: legacy.open_basis }), true);
  const o = e.open_basis.inputs, c = legacy.close_basis.inputs;
  assert.equal(e.open_basis.model, OPEN_GAP_MODEL); assert.deepEqual(e.open_basis.history_dates, ["2026-10-26", "2026-10-23", "2026-10-22"]);
  assert.equal(o.prior_close_date, "2026-10-26"); assert.equal(o.prior_close, 104);
  assert.deepEqual(o.gaps.map((g) => [g.date, g.open, g.previous_date, g.previous_close]), [["2026-10-26", 102, "2026-10-23", 101], ["2026-10-23", 99, "2026-10-22", 98]]);
  assert.equal(o.gaps[0].ratio, 102 / 101 - 1); assert.equal(o.mean_gap, ((102 / 101 - 1) + (99 / 98 - 1)) / 2); assert.equal(o.applied_gap, o.mean_gap); assert.equal(o.cap, 0.05);
  assert.equal(legacy.close_basis.model, CLOSE_SESSION_MODEL); assert.equal(c.expected_open, 105.05);
  assert.deepEqual(c.session_returns.map((s) => [s.date, s.open, s.close]), [["2026-10-26", 102, 104], ["2026-10-23", 99, 101], ["2026-10-22", 100, 98]]);
  assert.equal(c.mean_session_return, ((104 / 102 - 1) + (101 / 99 - 1) + (98 / 100 - 1)) / 3);
  // Large gaps are capped and the cap is visible in the basis.
  const capped = priorHistoryEstimate([{ date: "2026-10-26", rows: [bar("2026-10-26", 130, 131)] }, SESSIONS[1], SESSIONS[2]], "005930");
  assert.equal(capped.open_basis.inputs.applied_gap, 0.05); assert.ok(capped.open_basis.inputs.mean_gap > 0.05);
  assert.equal(priorHistoryEstimate(SESSIONS.slice(0, 2), "005930"), null);
  assert.equal(priorHistoryEstimate(SESSIONS, "000660"), null);
});

test("post-close retrospective rows have no estimate without a rank model (no substitute model)", () => {
  const [row, missing] = buildPostCloseRows(SESSIONS, [{ symbol: "005930", name: "A", actual_open: 106, actual_close: 108 }, { symbol: "000660", name: "B", actual_open: 10, actual_close: 11 }]);
  for (const r of [row, missing]) {
    assert.equal(r.expected_open, null); assert.equal(r.expected_close, null); assert.equal(r.error, null);
    assert.equal(r.missing_reason, "insufficient_prior_history"); assert.equal(Object.hasOwn(r, "expected_close_basis"), false);
  }
  assert.equal(row.session_return, 1.89, "observed values are still recorded");
});

function rankingRow(extra) {
  const base = { rank: 1, symbol: "005930", name: "A", expected_open: null, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, error: null, status: "valid" };
  const row = { ...base, ...extra };
  row.expected_return = row.expected_open > 0 && row.expected_close > 0 ? Math.round(((row.expected_close / row.expected_open - 1) * 100 + Number.EPSILON) * 100) / 100 : null;
  return row;
}

test("the row contract accepts consistent basis fields and rejects altered or orphaned ones", () => {
  const e = withLegacyThreeSessionClose(priorHistoryEstimate(SESSIONS, "005930"), SESSIONS, "005930");
  const source = { kind: "preopen_history", recorded_at: "2026-10-26T22:55:00Z", history_dates: e.open_basis.history_dates };
  const good = rankingRow({ expected_open: e.expected_open, expected_open_source: source, expected_open_basis: e.open_basis, expected_close: e.expected_close, expected_close_basis: e.close_basis });
  assert.equal(isRankingRow(good), true);
  const quote = rankingRow({ expected_open: 101, expected_open_source: { kind: "preopen_quote", recorded_at: "2026-10-26T23:19:50Z", history_dates: [] }, expected_open_basis: { model: PREOPEN_QUOTE_MODEL, history_dates: [], inputs: { open_price: 101, quote_at: "2026-10-26T23:19:50.000Z", market_status: "PREOPEN" } } });
  assert.equal(isRankingRow(quote), true);
  const alter = (fn) => { const row = structuredClone(good); fn(row); return row; };
  for (const [label, row] of [
    ["changed gap ratio", alter((r) => { r.expected_open_basis.inputs.gaps[0].ratio += 0.01; r.expected_open_basis.inputs.mean_gap += 0.005; })],
    ["changed prior close", alter((r) => { r.expected_open_basis.inputs.prior_close = 103; })],
    ["changed session mean", alter((r) => { r.expected_close_basis.inputs.mean_session_return = 0.02; r.expected_close_basis.inputs.applied_session_return = 0.02; })],
    ["basis without source", alter((r) => { delete r.expected_open_source; })],
    ["close basis without open basis", alter((r) => { delete r.expected_open_basis; })],
    ["extra input", alter((r) => { r.expected_open_basis.inputs.note = "x"; })],
    ["unknown model", alter((r) => { r.expected_open_basis.model = "other"; })],
  ]) assert.equal(isRankingRow(row), false, label);
  const quoteWithClose = structuredClone(quote); quoteWithClose.expected_close = 105.74; quoteWithClose.expected_close_basis = e.close_basis; quoteWithClose.expected_return = 4.69;
  assert.equal(isRankingRow(quoteWithClose), false, "a pre-open quote opening has no closing model");
});

async function pipelineRoot() {
  const root = await mkdtemp(join(tmpdir(), "kospi-basis-"));
  await mkdir(join(root, "data", "daily-history"), { recursive: true });
  const cache = { schema_version: 1, source: "naver-daily", target_date: "2026-10-27", started_at: "2026-10-26T22:40:00Z", retrieved_at: "2026-10-26T22:55:00Z", license_status: "unconfirmed", symbols: ["005930"], sessions: SESSIONS };
  await writeFile(join(root, "data", "daily-history", "2026-10-27.json"), JSON.stringify(cache));
  return root;
}

function fetchFor(quote) {
  const respond = (payload) => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(payload) });
  return naverRobotsFetch(async (url) => {
    if (String(url).includes("/marketValue")) return respond({ totalCount: 1, stocks: [{ itemCode: "005930", stockName: "A", stockEndType: "stock", sosok: "0" }] });
    if (String(url).includes("polling.finance")) return respond({ datas: [{ symbolCode: "005930", stockName: "A", stockExchangeType: { code: "KS" }, ...quote }] });
    throw new Error(`unexpected ${url}`);
  });
}

async function withPipeline(fn) {
  const root = await pipelineRoot(), old = process.cwd();
  const saved = { KOSPI_DAILY_HISTORY: process.env.KOSPI_DAILY_HISTORY, KOSPI_DATA_ROOT: process.env.KOSPI_DATA_ROOT, KOSPI_UNIVERSE_CACHE: process.env.KOSPI_UNIVERSE_CACHE, KOSPI_CRAWL_REQUEST_INTERVAL_MS: process.env.KOSPI_CRAWL_REQUEST_INTERVAL_MS };
  Object.assign(process.env, { KOSPI_DAILY_HISTORY: "naver-cache", KOSPI_DATA_ROOT: root, KOSPI_UNIVERSE_CACHE: "missing-universe.json", KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0" });
  try {
    process.chdir(root);
    const stage = async (mode, iso, quote) => run(["--mode", mode, "--provider", "naver-crawl", "--run-date", "2026-10-27", "--run-started-at", iso], { now: () => new Date(iso), fetchImpl: fetchFor(quote) });
    const read = async (label) => JSON.parse(await readFile(join(root, "data", "runs", "2026-10-27", `${label}.json`), "utf8"));
    await fn({ stage, read, root });
  } finally {
    process.chdir(old);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
}

const BUNDLE = ["expected_open", "expected_open_source", "expected_open_basis", "expected_close", "expected_close_basis"];
const pick = (row) => Object.fromEntries(BUNDLE.map((k) => [k, row[k]]));

test("scheduled forecast → open-settlement → close-settlement keeps the history forecast and its basis to the end (no rank model: no expected close)", async () => {
  await withPipeline(async ({ stage, read }) => {
    const forecast = await stage("forecast", "2026-10-26T23:20:00.000Z", { openPriceRaw: 0, closePriceRaw: 104, localTradedAt: "2026-10-27T08:19:50+09:00", marketStatus: "PREOPEN" });
    assert.equal(forecast.status, "ready", forecast.message);
    const f = (await read("0820")).rows[0];
    assert.equal(f.expected_open, 105.05); assert.equal(f.expected_close, null); assert.equal(f.expected_return, null);
    assert.equal(f.expected_open_source.kind, "preopen_history"); assert.equal(f.expected_open_basis.model, OPEN_GAP_MODEL); assert.equal(Object.hasOwn(f, "expected_close_basis"), false);
    assert.equal(f.evaluation_score, null, "종목 평가 shows — without an expected close");
    const forecastMeta = (await read("0820")).meta.source.metrics.close_model;
    assert.equal(forecastMeta.status, "unavailable"); assert.equal(forecastMeta.reused_from, null); assert.match(forecastMeta.reason, /rank_forecast missing; no earlier successfully trained rank model/);
    assert.deepEqual(f.expected_open_basis, priorHistoryEstimate(SESSIONS, "005930").open_basis);
    const opened = await stage("open-settlement", "2026-10-27T00:05:00.000Z", { openPriceRaw: 106, closePriceRaw: 107, localTradedAt: "2026-10-27T09:04:50+09:00", marketStatus: "OPEN" });
    assert.equal(opened.status, "ready", opened.message);
    const o = (await read("0900")).rows[0];
    assert.deepEqual(pick(o), pick(f)); assert.equal(o.actual_open, 106); assert.equal(o.expected_return, null);
    const closed = await stage("close-settlement", "2026-10-27T06:35:00.000Z", { openPriceRaw: 106, closePriceRaw: 108, localTradedAt: "2026-10-27T15:34:50+09:00", marketStatus: "CLOSE" });
    assert.equal(closed.status, "ready", closed.message);
    const c = (await read("1530")).rows[0];
    assert.deepEqual(pick(c), pick(f)); assert.equal(c.actual_close, 108); assert.equal(c.session_return, 1.89); assert.equal(c.error, null);
    const latest = JSON.parse(await readFile(join(process.cwd(), "data", "latest-snapshot.json"), "utf8")).rows[0];
    assert.deepEqual(pick(latest), pick(f));
  });
});

test("a pre-open quote forecast keeps its quote basis and has no closing estimate through settlement", async () => {
  await withPipeline(async ({ stage, read }) => {
    const forecast = await stage("forecast", "2026-10-26T23:20:00.000Z", { openPriceRaw: 103, closePriceRaw: 104, localTradedAt: "2026-10-27T08:19:50+09:00", marketStatus: "PREOPEN" });
    assert.equal(forecast.status, "ready", forecast.message);
    const f = (await read("0820")).rows[0];
    assert.equal(f.expected_open, 103); assert.equal(f.expected_open_source.kind, "preopen_quote"); assert.equal(f.expected_close, null); assert.equal(Object.hasOwn(f, "expected_close_basis"), false);
    assert.deepEqual(f.expected_open_basis, { model: PREOPEN_QUOTE_MODEL, history_dates: [], inputs: { open_price: 103, quote_at: "2026-10-26T23:19:50.000Z", market_status: "PREOPEN" } });
    await stage("open-settlement", "2026-10-27T00:05:00.000Z", { openPriceRaw: 106, closePriceRaw: 107, localTradedAt: "2026-10-27T09:04:50+09:00", marketStatus: "OPEN" });
    await stage("close-settlement", "2026-10-27T06:35:00.000Z", { openPriceRaw: 106, closePriceRaw: 108, localTradedAt: "2026-10-27T15:34:50+09:00", marketStatus: "CLOSE" });
    const c = (await read("1530")).rows[0];
    assert.deepEqual(pick(c), pick(f)); assert.equal(c.error, null);
  });
});

test("an intraday current-price baseline without a pre-open source is still removed at open-settlement", async () => {
  await withPipeline(async ({ stage, read, root }) => {
    await mkdir(join(root, "data", "runs", "2026-10-27"), { recursive: true });
    const legacy = { rank: 1, symbol: "005930", name: "A", expected_open: 104, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, error: null, quality: "naver_intraday_quote_baseline", status: "valid" };
    const snapshot = JSON.parse(await readFile(new URL("../data/latest-snapshot.json", import.meta.url), "utf8"));
    await writeFile(join(root, "data", "runs", "2026-10-27", "0820.json"), JSON.stringify({ ...snapshot, status: "ready", asOfDate: "2026-10-27", provider: { ...snapshot.provider, id: "naver-crawl" }, rows: [legacy], meta: { ...snapshot.meta, run_date: "2026-10-27", run_stage: "forecast" } }));
    const opened = await stage("open-settlement", "2026-10-27T04:05:00.000Z", { openPriceRaw: 106, closePriceRaw: 107, localTradedAt: "2026-10-27T13:04:50+09:00", marketStatus: "OPEN" });
    assert.equal(opened.status, "ready", opened.message);
    const o = (await read("0900")).rows[0];
    // The cache gives a retrospective estimate after the open; the legacy baseline (104) is not kept.
    assert.notEqual(o.expected_open, 104); assert.equal(o.expected_open_source.kind, "retrospective_history"); assert.equal(o.expected_open_basis.model, OPEN_GAP_MODEL);
  });
});

test("basis ratios, means and cross-basis prices are recomputed; tampered rows are rejected", async () => {
  const { isSnapshot } = await import("../providers/provider-adapter.js");
  const e = withLegacyThreeSessionClose(priorHistoryEstimate(SESSIONS, "005930"), SESSIONS, "005930");
  const good = rankingRow({ expected_open: e.expected_open, expected_open_source: { kind: "preopen_history", recorded_at: "2026-10-26T22:55:00Z", history_dates: e.open_basis.history_dates }, expected_open_basis: e.open_basis, expected_close: e.expected_close, expected_close_basis: e.close_basis });
  const alter = (fn) => { const row = structuredClone(good); fn(row); return row; };
  for (const [label, row] of [
    ["gap ratio not open/previous_close - 1", alter((r) => { r.expected_open_basis.inputs.gaps[1].ratio = 0.0105; })],
    ["mean_gap not the mean of the ratios", alter((r) => { r.expected_open_basis.inputs.mean_gap = 0.0101; r.expected_open_basis.inputs.applied_gap = 0.0101; })],
    ["session ratio not close/open - 1", alter((r) => { r.expected_close_basis.inputs.session_returns[2].ratio = -0.03; })],
    ["mean_session not the mean of the ratios", alter((r) => { r.expected_close_basis.inputs.mean_session_return = 0.00660329; r.expected_close_basis.inputs.applied_session_return = 0.00660329; })],
    ["prior_close not the latest session close", alter((r) => { r.expected_close_basis.inputs.session_returns[0].close = 105; r.expected_close_basis.inputs.session_returns[0].ratio = 105 / 102 - 1; })],
    ["gap open differs from session open", alter((r) => { r.expected_open_basis.inputs.gaps[1].open = 98; r.expected_open_basis.inputs.gaps[1].ratio = 0; })],
    ["close basis expected_open differs from the row", alter((r) => { r.expected_close_basis.inputs.expected_open = 105.06; })],
  ]) assert.equal(isRankingRow(row), false, label);
  // Floating-point representation differences inside the tolerance are accepted.
  assert.equal(isRankingRow(alter((r) => { r.expected_open_basis.inputs.gaps[0].ratio += 1e-15; })), true);
  const snapshot = JSON.parse(await readFile(new URL("../data/latest-snapshot.json", import.meta.url), "utf8"));
  const withRow = (asOfDate) => ({ ...snapshot, asOfDate, status: "ready", rows: [good], evaluation: undefined });
  delete snapshot.evaluation;
  assert.equal(isSnapshot(withRow("2026-10-27")), true);
  assert.equal(isSnapshot(withRow("2026-10-26")), false, "history date equal to the snapshot date");
  assert.equal(isSnapshot(withRow("2026-10-25")), false, "history after the snapshot date");
});

test("every committed snapshot under data/runs and latest-snapshot.json still validates", async () => {
  const { isSnapshot } = await import("../providers/provider-adapter.js");
  const { readdir } = await import("node:fs/promises");
  const root = new URL("../data/runs/", import.meta.url);
  const files = [];
  const walk = async (dir) => { for (const entry of await readdir(dir, { withFileTypes: true })) { const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir); if (entry.isDirectory()) await walk(url); else if (/^\d{4}\.json$/.test(entry.name)) files.push(url); } };
  await walk(root);
  files.push(new URL("../data/latest-snapshot.json", import.meta.url));
  assert.ok(files.length >= 10);
  const invalid = [];
  for (const file of files) if (!isSnapshot(JSON.parse(await readFile(file, "utf8")))) invalid.push(file.pathname);
  assert.deepEqual(invalid, []);
});

test("retired 20-session model is no longer produced; its committed basis still validates", async () => {
  const { CLOSE_SHRUNK_MODEL, SHRUNK_CAP, shrunkSessionReturn } = await import("../providers/forecast-basis.js");
  // First three candles are SESSIONS; 17 older candles alternate up and down around +0.5%.
  const older = Array.from({ length: 17 }, (_, k) => {
    const day = new Date(Date.UTC(2026, 9, 21) - k * 86400e3).toISOString().slice(0, 10);
    return { date: day, open: 1000, close: k % 2 ? 1010 : 1000 };
  });
  const returnHistory = [...SESSIONS.map((s) => ({ date: s.date, open: s.rows[0].open, close: s.rows[0].close })), ...older];
  const e = priorHistoryEstimate(SESSIONS, "005930", { returnHistory });
  assert.equal(e.expected_close, null, "20 candles without a rank model give no expected close");
  assert.equal(e.close_basis, null);
  // A committed shrunk basis (as stored by earlier runs) still validates.
  const sessionReturns = returnHistory.map((x) => ({ date: x.date, open: x.open, close: x.close, ratio: x.close / x.open - 1 }));
  const stats = shrunkSessionReturn(sessionReturns.map((x) => x.ratio));
  const basis = { model: CLOSE_SHRUNK_MODEL, history_dates: e.open_basis.history_dates, inputs: { expected_open: e.expected_open, session_returns: sessionReturns, ...stats, cap: SHRUNK_CAP } };
  const row = { expected_open: e.expected_open, expected_close: Math.round((e.expected_open * (1 + stats.applied_session_return) + Number.EPSILON) * 100) / 100, expected_open_basis: e.open_basis };
  assert.equal(isCloseBasis(basis, row), true);
  assert.equal(isCloseBasis({ ...basis, inputs: { ...basis.inputs, applied_session_return: stats.applied_session_return + 0.001 } }, row), false, "tampered value fails");
  assert.equal(shrunkSessionReturn(Array.from({ length: 20 }, (_, k) => 0.03 + k * 1e-4)).applied_session_return, 0.01);
  assert.equal(shrunkSessionReturn(Array(20).fill(0)).applied_session_return, 0);
});
