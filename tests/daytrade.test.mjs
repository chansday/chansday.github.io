import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DAYTRADE_TRAIN_DAYS, buildDays, daytradePicks, isDaytradeModel, predictDaytrade, trainDaytradeModel } from "../providers/daytrade-model.js";
import { runBacktest } from "../scripts/daytrade-backtest.mjs";

// Synthetic market: 320 symbols, 100 sessions; the session return reverses
// the opening gap (close/open - 1 = -0.5 x gap) plus noise.
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function market(days = 100, symbols = 320) {
  const observations = [], dates = Array.from({ length: days }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10));
  for (let s = 0; s < symbols; s++) {
    let close = 10000 + s * 10;
    for (const date of dates) {
      const gap = (rnd() - 0.5) * 0.04, open = Math.round(close * (1 + gap)), next = Math.round(open * (1 - 0.5 * gap + (rnd() - 0.5) * 0.004));
      observations.push({ symbol: String(100000 + s), date, open, close: next, high: Math.max(open, next) + 20, low: Math.min(open, next) - 20, volume: 200000 });
      close = next;
    }
  }
  return observations;
}

test("the day-trade model learns the opening-gap effect and only uses days before the scored one", () => {
  const days = buildDays(market());
  const model = trainDaytradeModel(days.slice(0, -1));
  assert.equal(isDaytradeModel(model), true);
  assert.ok(model.train_last_date < days.at(-1).date);
  assert.equal(model.train_days, DAYTRADE_TRAIN_DAYS);
  assert.ok(model.targets.close.weights.at(-1) < 0, "a gap-up is predicted to fall back");
  const predictions = predictDaytrade(model, days.at(-1));
  const picks = daytradePicks(predictions);
  assert.equal(picks.length, 20);
  assert.ok(picks.every((p) => p.gap < 0), "the top picks opened with a gap down");
  assert.equal(daytradePicks(predictions, { minTurnover: Infinity }).length, 0, "illiquid symbols are never picked");
});

test("the walk-forward backtest beats the gap-blind rank model on a gap-reversal market", () => {
  const result = runBacktest(buildDays(market()));
  const { daytrade_v1: daytrade, rank_model_v1: rank } = result;
  assert.ok(daytrade.summary.days > 0);
  assert.ok(daytrade.summary.mean_ic > 0.5);
  assert.ok(daytrade.summary.mean_net_return > rank.summary.mean_net_return);
});

test("signal files: 09:00 picks from the cache model and the 15:30 result with cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytrade-")), old = process.env.KOSPI_DATA_ROOT;
  try {
    process.env.KOSPI_DATA_ROOT = root;
    const { daytradeClose, daytradeOpen } = await import("../scripts/daytrade-signal.mjs");
    const observations = market(), days = buildDays(observations), target = days.at(-1).date;
    const model = trainDaytradeModel(days.slice(0, -1));
    const prior = new Map();
    for (const o of observations.filter((o) => o.date < target).sort((a, b) => b.date.localeCompare(a.date))) { if (!prior.has(o.symbol)) prior.set(o.symbol, []); if (prior.get(o.symbol).length < 20) prior.get(o.symbol).push([o.date, o.open, o.close, o.high, o.low, o.volume]); }
    const today = observations.filter((o) => o.date === target);
    await mkdir(join(root, "data", "daily-history"), { recursive: true }); await mkdir(join(root, "data", "runs", target), { recursive: true });
    await writeFile(join(root, "data", "daily-history", `${target}.json`), JSON.stringify({ daytrade_model: model, return_history: Object.fromEntries(prior) }));
    const rows = today.map((o) => ({ symbol: o.symbol, name: `N${o.symbol}`, actual_open: o.open, actual_close: o.close, actual_high: o.high, actual_low: o.low }));
    await writeFile(join(root, "data", "runs", target, "0900.json"), JSON.stringify({ meta: { run_date: target, run_stage: "open-settlement" }, rows }));
    assert.equal((await daytradeOpen({ date: target })).status, "ready");
    const picked = JSON.parse(await readFile(join(root, "data", "daytrade", `${target}.json`), "utf8"));
    assert.equal(picked.picks.length, 20); assert.equal(picked.result, null);
    await writeFile(join(root, "data", "runs", target, "1530.json"), JSON.stringify({ meta: { run_date: target, run_stage: "close-settlement" }, rows }));
    const closed = await daytradeClose({ date: target });
    assert.equal(closed.status, "ready"); assert.equal(closed.settled, 20);
    const ledger = JSON.parse(await readFile(join(root, "data", "daytrade", "ledger.json"), "utf8"));
    assert.deepEqual(ledger.days.map((d) => d.date), [target]);
    assert.ok(closed.net_return > closed.market_return - 0.2, "picks net of cost are evaluated against the market");
  } finally { if (old === undefined) delete process.env.KOSPI_DATA_ROOT; else process.env.KOSPI_DATA_ROOT = old; await rm(root, { recursive: true, force: true }); }
});
