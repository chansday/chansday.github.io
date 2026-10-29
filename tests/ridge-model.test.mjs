import test from "node:test";
import assert from "node:assert/strict";
import { FEATURE_SESSIONS, MIN_SAMPLES_PER_DAY, RIDGE_MODEL, TRAIN_DAYS, isRidgeModel, ridgeFeatures, ridgePredict, trainRidgeModel } from "../providers/ridge-model.js";
import { isCloseBasis, priorHistoryEstimate } from "../providers/forecast-basis.js";

// Deterministic pseudo-random bars: 300 symbols x 90 sessions where the next
// session return follows the 20-session mean, so the fit must find it.
function lcg(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5; }
function history(symbols = MIN_SAMPLES_PER_DAY, sessions = TRAIN_DAYS + FEATURE_SESSIONS + 10) {
  const rnd = lcg(7), out = new Map();
  const dates = Array.from({ length: sessions }, (_, k) => new Date(Date.UTC(2026, 4, 1) + k * 86400e3).toISOString().slice(0, 10));
  for (let s = 0; s < symbols; s++) {
    const drift = rnd() * 0.004; let price = 10000; const bars = [];
    for (const date of dates) { const open = Math.round(price * (1 + rnd() * 0.01)); const close = Math.max(1, Math.round(open * (1 + drift + rnd() * 0.02))); bars.push({ date, open, close }); price = close; }
    out.set(String(100000 + s), bars);
  }
  return { out, dates };
}

test("ridge features follow the documented definitions", () => {
  const bars = Array.from({ length: 20 }, (_, k) => ({ open: 100, close: 100 + (k % 4) }));
  bars[0] = { open: 110, close: 111 }; // newest first
  const f = ridgeFeatures(bars), r = bars.map((b) => b.close / b.open - 1);
  assert.ok(Math.abs(f[0] - [...r].sort((a, b) => a - b).slice(2, 18).reduce((s, v) => s + v, 0) / 16) < 1e-15);
  assert.equal(f[1], r.slice(0, 5).reduce((s, v) => s + v, 0) / 5); assert.equal(f[2], r[0]);
  assert.equal(f[3], 110 / bars[1].close - 1); assert.equal(f[4], 111 / bars[19].open - 1);
  assert.equal(ridgeFeatures(bars.slice(1)), null);
});

test("training needs 60 full sessions, recovers a positive drift weight and predicts within the clipped range", () => {
  const { out, dates } = history();
  const m = trainRidgeModel(out);
  assert.equal(m.model, RIDGE_MODEL); assert.equal(isRidgeModel(m), true); assert.equal(m.train_days, TRAIN_DAYS);
  assert.equal(m.train_last_date, dates[dates.length - 1]); assert.ok(m.weights[1] > 0, "trimmed 20-session mean must carry the drift");
  const bars = out.get("100000").slice(-20).reverse();
  const { clipped, predicted } = ridgePredict(m, ridgeFeatures(bars));
  assert.ok(clipped.every((v, j) => v >= m.lower[j] && v <= m.upper[j])); assert.ok(Number.isFinite(predicted) && Math.abs(predicted) < 0.05);
  assert.equal(trainRidgeModel(new Map([...out].slice(0, MIN_SAMPLES_PER_DAY - 1))), null, "too few symbols per day");
  assert.equal(trainRidgeModel(new Map([...out].map(([s, b]) => [s, b.slice(0, 70)]))), null, "too few sessions");
});

test("estimate uses the model only with 20 candles, stores a verifiable basis and rejects tampering", () => {
  const { out } = history();
  const m = trainRidgeModel(out);
  const bars = out.get("100001");
  const candles = bars.slice(-20).reverse().map((b) => ({ date: b.date, open: b.open, close: b.close }));
  const bar = (b) => ({ symbol: "100001", date: b.date, open: b.open, high: Math.max(b.open, b.close), low: Math.min(b.open, b.close), close: b.close, volume: 10 });
  const sessions = candles.slice(0, 3).map((c) => ({ date: c.date, rows: [bar(c)] }));
  const e = priorHistoryEstimate(sessions, "100001", { returnHistory: candles, forecastModel: m });
  assert.equal(e.close_basis.model, RIDGE_MODEL);
  const row = { expected_open: e.expected_open, expected_close: e.expected_close, expected_open_basis: e.open_basis, expected_close_basis: e.close_basis };
  assert.equal(isCloseBasis(e.close_basis, row), true);
  const i = e.close_basis.inputs;
  assert.equal(isCloseBasis({ ...e.close_basis, inputs: { ...i, predicted_return: i.predicted_return + 1e-4 } }, row), false);
  assert.equal(isCloseBasis({ ...e.close_basis, inputs: { ...i, model_params: { ...m, weights: m.weights.map((w, k) => k ? w : w + 1e-4) } } }, row), false);
  assert.equal(isCloseBasis({ ...e.close_basis, inputs: { ...i, model_params: { ...m, train_last_date: "2099-01-01" } } }, row), false, "model trained after the inputs");
  // On a model day a symbol the model cannot score gets no expected close (no
  // differently scaled fallback); without a model the 20-session shrunk model applies.
  const unscored = priorHistoryEstimate(sessions, "100001", { returnHistory: candles.slice(0, 19), forecastModel: m });
  assert.equal(unscored.expected_close, null); assert.equal(unscored.close_basis, null); assert.ok(unscored.expected_open > 0);
  assert.notEqual(priorHistoryEstimate(sessions, "100001", { returnHistory: candles }).close_basis.model, RIDGE_MODEL);
});

test("ranking uses the unrounded expected return, then symbol code", async () => {
  const { compareByExpectedReturn } = await import("../providers/evaluation-contract.js");
  const { sortRankingRows } = await import("../providers/ranking-sort.js");
  // Both round to +0.12%; 100.124 ranks above 100.116; equal values fall back to symbol.
  const rows = [{ symbol: "000003", expected_open: 100, expected_close: 100.116 }, { symbol: "000002", expected_open: 100, expected_close: 100.124 }, { symbol: "000001", expected_open: 100, expected_close: 100.116 }, { symbol: "000000", expected_open: null, expected_close: null }];
  assert.deepEqual([...rows].sort(compareByExpectedReturn).map((r) => r.symbol), ["000002", "000001", "000003", "000000"]);
  const ui = rows.map((r) => ({ symbol: r.symbol, name: r.symbol, expectedReturn: r.expected_open ? 0.12 : null, expectedReturnRaw: r.expected_open ? (r.expected_close / r.expected_open - 1) * 100 : null }));
  assert.deepEqual(sortRankingRows(ui, "expectedReturn").map((r) => r.symbol), ["000002", "000001", "000003", "000000"]);
});
