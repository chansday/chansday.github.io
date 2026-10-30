import test from "node:test";
import assert from "node:assert/strict";
import { RECONSTRUCTED_STAGES, buildForecastRows, buildStageSnapshot, stageRows } from "../scripts/reconstruct-day.mjs";
import { isSnapshot } from "../providers/provider-adapter.js";
import { runAll } from "../scripts/run-all.mjs";

const D = "2026-10-27", DATES = ["2026-10-26", "2026-10-23", "2026-10-22"];
const bar = (symbol, date, open, close) => ({ symbol, date, open, close, high: Math.max(open, close) + 10, low: Math.min(open, close) - 10, volume: 1000 });
const sessions = DATES.map((date, i) => ({ date, rows: [bar("000001", date, 1000 + i * 10, 1010 + i * 10), bar("000002", date, 2000, 1990 - i * 5)] }));
const history = {
  sessions,
  return_history: Object.fromEntries(["000001", "000002"].map((symbol) => [symbol, sessions.map((s) => s.rows.find((r) => r.symbol === symbol))])),
  forecast_model: null, rank_forecast: null,
};
const universe = [{ symbol: "000001", name: "A" }, { symbol: "000002", name: "B" }, { symbol: "000003", name: "C" }, { symbol: "000004", name: "Listed later" }];
const candles = new Map([["000001", bar("000001", D, 1020, 1050)], ["000002", bar("000002", D, 1985, 1970)]]);
const fetched = { status: "ready", requested: 4, history, robots: null };

test("reconstructed stage files follow a live day: forecasts first, actual values from 09:00 and 15:30", () => {
  const rows = buildForecastRows({ runDate: D, universe, history, candles, zeroVolume: new Set(["000003"]), recordedAt: "2026-10-30T05:00:00.000Z" });
  assert.deepEqual(rows.map((r) => r.symbol), ["000001", "000002", "000003"], "a symbol with no candle and no halt evidence did not trade on D");
  const snapshots = RECONSTRUCTED_STAGES.map(([, stage], index) => buildStageSnapshot({ runDate: D, runId: "41.1", producedAt: "2026-10-30T05:00:00.000Z", stageIndex: index, rows: stageRows(rows, stage), fetched, message: "m" }));
  for (const snapshot of snapshots) {
    assert.equal(isSnapshot(snapshot), true, snapshot.meta.run_stage);
    assert.equal(snapshot.status, "ready"); assert.equal(snapshot.asOfDate, D); assert.equal(snapshot.meta.run_date, D);
  }
  assert.deepEqual(snapshots.map((s) => s.meta.run_stage), ["update-results", "analysis", "forecast", "open-settlement", "close-settlement"]);
  const [, , forecast, open, close] = snapshots.map((s) => new Map(s.rows.map((r) => [r.symbol, r])));
  assert.ok(forecast.get("000001").expected_close > 0); assert.equal(forecast.get("000001").actual_open, null);
  assert.equal(open.get("000001").actual_open, 1020); assert.equal(open.get("000001").actual_close, null);
  assert.equal(close.get("000001").actual_close, 1050); assert.equal(close.get("000001").session_return, 2.94);
  assert.notEqual(close.get("000001").error, null);
  assert.equal(close.get("000003").trading_status, "no_trade_observed"); assert.equal(close.get("000003").expected_open, null);
  assert.equal(snapshots[2].pipeline.forecast.status, "ready"); assert.equal(snapshots[2].pipeline.openSettlement.status, "pending");
  assert.ok(forecast.get("000001").expected_open_basis.history_dates.every((date) => date < D), "only bars before D");
});

test("run all now reconstructs a past trading day without a stored close settlement", async () => {
  let called = null;
  const summary = await runAll(["--run-date", "2026-10-20", "--run-started-at", "2026-10-30T05:00:00Z", "--run-id", "41.1"], {
    stageRunner: async () => { throw new Error("live stages must not run for a past date"); },
    retrospectiveRunner: async () => { throw new Error("no stored settlement to re-evaluate"); },
    reconstructor: async (args) => { called = args; return { status: "ready", reason: "rebuilt", wrote: [], retrospective: { status: "ready", evaluated: 2, total: 2 } }; },
  });
  assert.deepEqual(called, { runDate: "2026-10-20", runId: "41.1" });
  assert.equal(summary.status, "ready"); assert.equal(summary.commitAllowed, true); assert.equal(summary.reconstructed, true);
  assert.equal(summary.retrospective.historical, true); assert.equal(summary.retrospective.sourceRunId, "41.1");
  const failed = await runAll(["--run-date", "2026-10-20", "--run-started-at", "2026-10-30T05:00:00Z", "--run-id", "41.1"], {
    stageRunner: async () => ({ status: "ready" }), reconstructor: async () => ({ status: "blocked", reason: "robots", wrote: [] }),
  });
  assert.equal(failed.status, "blocked"); assert.equal(failed.commitAllowed, false);
});
