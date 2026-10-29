import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RANK_FEATURE_SESSIONS, RANK_MIN_SYMBOLS, RANK_MODEL, RANK_TRAIN_DAYS, isRankModel, predictCrossSection, rankFeatures, rankPredict, trainRankModel } from "../providers/rank-model.js";
import { isCloseBasis, priorHistoryEstimate } from "../providers/forecast-basis.js";
import { loadNaverDailyHistory, priorTradingDates } from "../providers/naver-daily-cache.js";

function lcg(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5; }
// 300 symbols x 90 sessions; each symbol has its own drift so the trimmed-mean
// rank must carry a positive weight.
function history(symbols = RANK_MIN_SYMBOLS, sessions = RANK_TRAIN_DAYS + RANK_FEATURE_SESSIONS + 10) {
  const rnd = lcg(11), out = new Map();
  const dates = Array.from({ length: sessions }, (_, k) => new Date(Date.UTC(2026, 4, 1) + k * 86400e3).toISOString().slice(0, 10));
  for (let s = 0; s < symbols; s++) {
    const drift = rnd() * 0.006; let price = 10000; const bars = [];
    for (const date of dates) {
      const open = Math.round(price * (1 + rnd() * 0.01)), close = Math.max(1, Math.round(open * (1 + drift + rnd() * 0.02)));
      bars.push({ date, open, close, high: Math.max(open, close) + 10, low: Math.min(open, close) - 10, volume: 1000 + Math.round((rnd() + 0.5) * 9000) });
      price = close;
    }
    out.set(String(100000 + s), bars);
  }
  return { out, dates };
}
const lastBars = (bars) => bars.slice(-RANK_FEATURE_SESSIONS).reverse();

test("rank features follow the documented definitions", () => {
  const bars = Array.from({ length: 20 }, (_, k) => ({ open: 100, close: 101 + (k % 3), high: 110, low: 95, volume: 1000 + k }));
  const f = rankFeatures(bars), asc = [...bars].reverse(), last = asc[19];
  assert.equal(f.length, 11);
  assert.equal(f[6], asc.reduce((s, b) => s + (b.high - b.low) / b.open, 0) / 20);
  assert.equal(f[7], Math.log(last.volume / (asc.slice(0, 19).reduce((s, b) => s + b.volume, 0) / 19)));
  assert.equal(f[8], (last.close - last.low) / (last.high - last.low) - 0.5);
  assert.equal(f[10], Math.log(last.close * asc.reduce((s, b) => s + b.volume, 0) / 20));
  assert.equal(rankFeatures(bars.slice(1)), null);
  assert.equal(rankFeatures([{ ...bars[0], high: 99 }, ...bars.slice(1)]), null, "high below close is invalid");
});

test("training needs 60 sessions of 300 symbols; predictions rank the cross-section and stay uncapped but small", () => {
  const { out, dates } = history();
  const m = trainRankModel(out);
  assert.equal(isRankModel(m), true); assert.equal(m.train_last_date, dates[dates.length - 1]); assert.ok(m.weights[1] > 0);
  const preds = predictCrossSection(m, new Map([...out].map(([s, b]) => [s, lastBars(b)])));
  const values = Object.values(preds);
  assert.equal(values.length, RANK_MIN_SYMBOLS);
  assert.ok(values.every((p) => p.ranks.every((r) => r >= -0.5 && r <= 0.5)));
  assert.deepEqual(values.map((p) => p.ranks[0]).sort((a, b) => a - b).slice(0, 2), [-0.5, -0.5 + 1 / (RANK_MIN_SYMBOLS - 1)]);
  assert.ok(values.every((p) => Math.abs(p.predicted) < 0.05));
  assert.equal(trainRankModel(new Map([...out].slice(0, RANK_MIN_SYMBOLS - 1))), null);
  assert.equal(predictCrossSection(m, new Map([...out].slice(0, RANK_MIN_SYMBOLS - 1).map(([s, b]) => [s, lastBars(b)]))), null);
});

test("estimate stores a verifiable rank basis; tampering fails; the cache re-verifies the whole cross-section", async () => {
  const { out } = history();
  const m = trainRankModel(out);
  const preds = predictCrossSection(m, new Map([...out].map(([s, b]) => [s, lastBars(b)])));
  const symbol = "100005", bars = lastBars(out.get(symbol));
  const bar = (b) => ({ symbol, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  const sessions = bars.slice(0, 3).map((b) => ({ date: b.date, rows: [bar(b)] }));
  const e = priorHistoryEstimate(sessions, symbol, { returnHistory: bars, rankForecast: { model: m, predictions: preds } });
  assert.equal(e.close_basis.model, RANK_MODEL);
  assert.equal(e.close_basis.inputs.predicted_return, rankPredict(m, preds[symbol].ranks));
  const row = { expected_open: e.expected_open, expected_close: e.expected_close, expected_open_basis: e.open_basis, expected_close_basis: e.close_basis };
  assert.equal(isCloseBasis(e.close_basis, row), true);
  const i = e.close_basis.inputs;
  assert.equal(isCloseBasis({ ...e.close_basis, inputs: { ...i, predicted_return: i.predicted_return + 1e-4 } }, row), false);
  assert.equal(isCloseBasis({ ...e.close_basis, inputs: { ...i, features: i.features.map((v, k) => k ? v : v + 1e-3) } }, row), false);
  assert.equal(isCloseBasis({ ...e.close_basis, inputs: { ...i, candles: i.candles.map((c, k) => k === 10 ? { ...c, volume: c.volume + 1 } : c) } }, row), false);
  const missing = priorHistoryEstimate(sessions, symbol, { returnHistory: bars, rankForecast: { model: m, predictions: {} } });
  assert.equal(missing.expected_close, null, "an unscored symbol gets no expected close on a rank-model day");

  // Cache: a stored prediction that does not reproduce invalidates the cache.
  const target = "2026-10-27", dates = await priorTradingDates(target);
  const symbols = [...out.keys()];
  const shift = (b, k) => ({ ...b, date: k < 3 ? dates[k] : new Date(Date.parse(`${dates[2]}T00:00:00Z`) - (k - 2) * 86400e3).toISOString().slice(0, 10) });
  const hist = Object.fromEntries(symbols.map((s) => [s, lastBars(out.get(s)).map(shift)]));
  const model = { ...m, train_first_date: "2026-07-01", train_last_date: dates[0] };
  const predictions = predictCrossSection(model, new Map(Object.entries(hist)));
  const record = { schema_version: 1, source: "naver-daily", target_date: target, started_at: "2026-10-26T22:40:00Z", retrieved_at: "2026-10-26T22:55:00Z", license_status: "unconfirmed", symbols,
    sessions: dates.map((date, k) => ({ date, rows: symbols.map((s) => ({ symbol: s, ...hist[s][k] })) })),
    return_history: Object.fromEntries(symbols.map((s) => [s, hist[s].map((b) => [b.date, b.open, b.close, b.high, b.low, b.volume])])),
    rank_forecast: { model, predictions } };
  const root = await mkdtemp(join(tmpdir(), "rank-cache-")), path = join(root, "cache.json");
  const load = () => loadNaverDailyHistory({ targetDate: target, path, now: () => new Date("2026-10-26T23:20:00Z") });
  try {
    await writeFile(path, JSON.stringify(record));
    const ok = await load();
    assert.equal(ok.ok, true, ok.reason); assert.equal(Object.keys(ok.rank_forecast.predictions).length, symbols.length);
    record.rank_forecast.predictions[symbols[0]].predicted += 1e-4; await writeFile(path, JSON.stringify(record));
    assert.equal((await load()).ok, false, "tampered prediction");
    record.rank_forecast.predictions[symbols[0]].predicted -= 1e-4; delete record.rank_forecast.predictions[symbols[1]]; await writeFile(path, JSON.stringify(record));
    assert.equal((await load()).ok, false, "a dropped symbol changes every rank");
  } finally { await rm(root, { recursive: true, force: true }); }
});
