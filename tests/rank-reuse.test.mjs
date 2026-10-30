import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RANK_FEATURE_SESSIONS, RANK_MIN_SYMBOLS, RANK_MODEL, RANK_TRAIN_DAYS, predictCrossSection, rankPredict, trainRankModel } from "../providers/rank-model.js";
import { CLOSE_SESSION_MODEL, CLOSE_SHRUNK_MODEL, isCloseBasis, priorHistoryEstimate } from "../providers/forecast-basis.js";
import { RIDGE_MODEL } from "../providers/ridge-model.js";
import { loadNaverDailyHistory, priorTradingDates, reuseRankForecast } from "../providers/naver-daily-cache.js";
import { formatEvaluationScore, withEvaluationScores } from "../providers/evaluation-score.js";
import { buildSelectedDetail } from "../providers/selected-detail.js";

// 300 symbols x 90 sessions (same generator as rank-model.test.mjs).
function lcg(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5; }
function history(seed = 11) {
  const rnd = lcg(seed), out = new Map();
  const dates = Array.from({ length: RANK_TRAIN_DAYS + RANK_FEATURE_SESSIONS + 10 }, (_, k) => new Date(Date.UTC(2026, 4, 1) + k * 86400e3).toISOString().slice(0, 10));
  for (let s = 0; s < RANK_MIN_SYMBOLS; s++) {
    const drift = rnd() * 0.006; let price = 10000; const bars = [];
    for (const date of dates) {
      const open = Math.round(price * (1 + rnd() * 0.01)), close = Math.max(1, Math.round(open * (1 + drift + rnd() * 0.02)));
      bars.push({ date, open, close, high: Math.max(open, close) + 10, low: Math.min(open, close) - 10, volume: 1000 + Math.round((rnd() + 0.5) * 9000) });
      price = close;
    }
    out.set(String(100000 + s), bars);
  }
  return out;
}
const OUT = history(), OUT_T = history(29);
const SYMBOLS = [...OUT.keys()];
const P = "2026-10-27", T = "2026-10-28";
const NOW = () => new Date("2026-10-27T23:20:00Z");

// A daily-history cache for `target`: the newest 20 bars of `out`, re-dated to
// the target's prior trading days; rankForecast: "trained" | null | undefined | "tampered".
async function cacheRecord(target, out, { rank, model } = {}) {
  const dates = await priorTradingDates(target);
  const shift = (b, k) => ({ ...b, date: k < 3 ? dates[k] : new Date(Date.parse(`${dates[2]}T00:00:00Z`) - (k - 2) * 86400e3).toISOString().slice(0, 10) });
  const hist = Object.fromEntries(SYMBOLS.map((s) => [s, out.get(s).slice(-RANK_FEATURE_SESSIONS).reverse().map(shift)]));
  const day = Date.parse(`${target}T00:00:00+09:00`);
  const record = { schema_version: 1, source: "naver-daily", target_date: target, started_at: new Date(day + 7.66 * 3600e3 - 3600e3).toISOString(), retrieved_at: new Date(day + 7.9 * 3600e3 - 3600e3).toISOString(), license_status: "unconfirmed", symbols: SYMBOLS,
    sessions: dates.map((date, k) => ({ date, rows: SYMBOLS.map((s) => ({ symbol: s, ...hist[s][k] })) })),
    return_history: Object.fromEntries(SYMBOLS.map((s) => [s, hist[s].map((b) => [b.date, b.open, b.close, b.high, b.low, b.volume])])) };
  if (rank === null) record.rank_forecast = null;
  else if (rank) {
    const m = { ...model, train_last_date: dates[0] };
    const predictions = predictCrossSection(m, new Map(Object.entries(hist)));
    if (rank === "tampered") predictions[SYMBOLS[0]].predicted += 1e-4;
    record.rank_forecast = { model: m, predictions };
  }
  return { record, hist, dates };
}

async function withRoot(files, fn) {
  const root = await mkdtemp(join(tmpdir(), "rank-reuse-"));
  try {
    for (const [date, record] of Object.entries(files)) await writeFile(join(root, `${date}.json`), JSON.stringify(record));
    const load = (target) => loadNaverDailyHistory({ targetDate: target, path: join(root, `${target}.json`), historyDir: root, now: NOW });
    await fn({ root, load });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const MODEL = trainRankModel(OUT);

test("the day's own rank model is used when it trained and reproduces", async () => {
  const prev = await cacheRecord(P, OUT, { rank: "trained", model: MODEL });
  await withRoot({ [P]: prev.record }, async ({ load }) => {
    const h = await load(P);
    assert.equal(h.ok, true, h.reason);
    assert.deepEqual(h.rank_forecast_status, { status: "trained", model: RANK_MODEL, train_last_date: prev.dates[0], reused_from: null, reason: null });
    assert.equal(h.rank_forecast.model.reused_from, undefined);
  });
});

for (const [label, rank, reason] of [["missing", undefined, /rank_forecast missing/], ["training failed (null)", null, /training failed/], ["does not reproduce", "tampered", /does not reproduce/]]) {
  test(`a failed day (${label}) reuses the most recent successful rank model on that day's bars`, async () => {
    const prev = await cacheRecord(P, OUT, { rank: "trained", model: MODEL });
    const today = await cacheRecord(T, OUT_T, { rank, model: MODEL });
    await withRoot({ [P]: prev.record, [T]: today.record }, async ({ load }) => {
      const h = await load(T);
      assert.equal(h.ok, true, h.reason);
      assert.equal(h.rank_forecast_status.status, "reused"); assert.equal(h.rank_forecast_status.reused_from, P);
      assert.equal(h.rank_forecast_status.train_last_date, prev.dates[0]); assert.match(h.rank_forecast_status.reason, reason);
      const used = h.rank_forecast.model;
      assert.equal(used.reused_from, P); assert.equal(used.train_last_date, prev.record.rank_forecast.model.train_last_date); assert.ok(used.train_last_date < T);
      assert.deepEqual(used.weights, prev.record.rank_forecast.model.weights, "coefficients come from the earlier successful training");
      // Features and ranks come from the target day's own 20 sessions.
      const expected = predictCrossSection(prev.record.rank_forecast.model, new Map(Object.entries(today.hist)));
      const symbol = SYMBOLS[5];
      assert.deepEqual(h.rank_forecast.predictions[symbol].ranks, expected[symbol].ranks);
      const e = priorHistoryEstimate(h.sessions, symbol, { returnHistory: h.return_history[symbol], rankForecast: h.rank_forecast });
      assert.equal(e.close_basis.model, RANK_MODEL); assert.equal(e.close_basis.inputs.model_params.reused_from, P);
      assert.equal(e.close_basis.inputs.predicted_return, rankPredict(used, expected[symbol].ranks));
      assert.equal(isCloseBasis(e.close_basis, { expected_open: e.expected_open, expected_close: e.expected_close, expected_open_basis: e.open_basis }), true);
    });
  });
}

test("without any earlier successful model nothing substitutes: expected_close is null and 종목 평가 shows —", async () => {
  const today = await cacheRecord(T, OUT_T, {});
  const failedPrev = await cacheRecord(P, OUT, { rank: "tampered", model: MODEL });
  for (const files of [{ [T]: today.record }, { [T]: today.record, [P]: failedPrev.record }]) {
    await withRoot(files, async ({ load }) => {
      const h = await load(T);
      assert.equal(h.ok, true, h.reason);
      assert.equal(h.rank_forecast, null);
      assert.equal(h.rank_forecast_status.status, "unavailable"); assert.match(h.rank_forecast_status.reason, /no earlier successfully trained rank model/);
      const rows = SYMBOLS.slice(0, 3).map((symbol) => {
        const e = priorHistoryEstimate(h.sessions, symbol, { returnHistory: h.return_history[symbol], rankForecast: h.rank_forecast });
        assert.ok(e.expected_open > 0); assert.equal(e.expected_close, null); assert.equal(e.close_basis, null);
        return { symbol, expected_open: e.expected_open, expected_close: e.expected_close };
      });
      assert.deepEqual(withEvaluationScores(rows).map((row) => formatEvaluationScore(row.evaluation_score)), ["—", "—", "—"]);
    });
  }
});

test("the retired ridge, 20-session and 3-session close models are never selected", async () => {
  const today = await cacheRecord(T, OUT_T, {});
  await withRoot({ [T]: today.record }, async ({ load }) => {
    const h = await load(T);
    for (const symbol of SYMBOLS.slice(0, 20)) {
      for (const returnHistory of [h.return_history[symbol], h.return_history[symbol].slice(0, 3), h.return_history[symbol].map(({ date, open, close }) => ({ date, open, close })), null]) {
        const e = priorHistoryEstimate(h.sessions, symbol, { returnHistory, forecastModel: { model: RIDGE_MODEL }, rankForecast: null });
        assert.equal(e.expected_close, null);
        assert.ok(![CLOSE_SESSION_MODEL, CLOSE_SHRUNK_MODEL, RIDGE_MODEL].includes(e.close_basis?.model));
      }
    }
  });
  const source = await readFile(new URL("../providers/forecast-inputs.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /trainRidgeModel/, "the ridge model is no longer trained");
});

test("reuseRankForecast reports the bars shortfall instead of guessing", async () => {
  const prev = await cacheRecord(P, OUT, { rank: "trained", model: MODEL });
  await withRoot({ [P]: prev.record }, async ({ root }) => {
    const result = await reuseRankForecast({ targetDate: T, returnHistory: {}, now: NOW, historyDir: root });
    assert.equal(result.rank_forecast, null);
    assert.equal(result.status.status, "unavailable"); assert.equal(result.status.reused_from, P); assert.match(result.status.reason, /fewer than the minimum symbols/);
  });
});

test("the screen labels a reused model with its training date", async () => {
  const prev = await cacheRecord(P, OUT, { rank: "trained", model: MODEL });
  const today = await cacheRecord(T, OUT_T, {});
  await withRoot({ [P]: prev.record, [T]: today.record }, async ({ load }) => {
    const h = await load(T);
    const symbol = SYMBOLS[1];
    const e = priorHistoryEstimate(h.sessions, symbol, { returnHistory: h.return_history[symbol], rankForecast: h.rank_forecast });
    const row = { symbol, name: "A", expected_open: e.expected_open, expected_close: e.expected_close, actual_open: null, actual_close: null,
      expected_open_source: { kind: "preopen_history", recorded_at: "2026-10-27T22:55:00Z", history_dates: e.open_basis.history_dates }, expected_open_basis: e.open_basis, expected_close_basis: e.close_basis };
    const detail = buildSelectedDetail(row, {});
    const body = JSON.stringify(detail);
    assert.match(body, new RegExp(`직전 모델 재사용 \\(${P} 학습\\)`));
  });
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /function modelReuseText\(info\) \{ return info\?\.reusedFrom \? ` · 직전 모델 재사용 \(\$\{info\.reusedFrom\} 학습\)` : ""; \}/);
  assert.match(app, /\$\{modelReuseText\(modelInfo\)\}/); assert.match(app, /\$\{modelReuseText\(info\)\}/);
});
