// Walk-forward day-trade backtest. For each test day the models are trained
// only on the DAYTRADE_TRAIN_DAYS sessions before it, scored with the day's
// open, and the top DAYTRADE_TOP_N liquid symbols are bought at the open and
// sold at the close (equal weight, DAYTRADE_COST_PCT round-trip cost).
// Usage: node scripts/daytrade-backtest.mjs --bars file.json [--bars more.json] [--out data/daytrade/backtest.json]
//   bars files: { observations: [{ symbol, date, open, high, low, close, volume }] }
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DAYTRADE_COST_PCT, DAYTRADE_FEATURE_NAMES, DAYTRADE_MIN_TURNOVER, DAYTRADE_TOP_N, DAYTRADE_TRAIN_DAYS, buildDays, daytradePicks, predictDaytrade, trainDaytradeModel } from "../providers/daytrade-model.js";
import { createProgressLog } from "../providers/progress-log.js";

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const round = (v, d = 4) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function spearman(x, y) {
  const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = Array(v.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry);
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < x.length; i++) { c += (rx[i] - mx) * (ry[i] - my); vx += (rx[i] - mx) ** 2; vy += (ry[i] - my) ** 2; }
  return vx && vy ? c / Math.sqrt(vx * vy) : null;
}

// Strategies scored per day; each returns predictions [{ symbol, close, turnover, ... }].
const STRATEGIES = {
  // The live 11-feature rank model (no opening gap, constant market level).
  rank_model_v1: { label: "현재 순위 모델 (갭 없음)", train: (days) => trainDaytradeModel(days, { columns: DAYTRADE_FEATURE_NAMES.slice(0, -1).map((_, j) => j), useMarket: false }) },
  daytrade_v1: { label: "단타 모델 (시가 갭 + 시장 갭)", train: (days) => trainDaytradeModel(days) },
  gap_reversal: { label: "단순 갭 역추세 (갭 하락 순)", score: (day) => day.entries.map((e) => ({ symbol: e.symbol, turnover: e.turnover, close: -e.gap })) },
};

function dayResult(day, predictions) {
  const realised = new Map(day.entries.filter((e) => e.targets).map((e) => [e.symbol, e.targets]));
  const scored = predictions.filter((p) => realised.has(p.symbol));
  const picks = daytradePicks(scored);
  const net = picks.map((p) => realised.get(p.symbol).close * 100 - DAYTRADE_COST_PCT);
  const liquid = scored.filter((p) => p.turnover >= DAYTRADE_MIN_TURNOVER);
  return {
    date: day.date, picks: picks.length,
    net_return: round(mean(net)),
    market_return: round(mean(liquid.map((p) => realised.get(p.symbol).close * 100))),
    high: round(mean(picks.map((p) => realised.get(p.symbol).high * 100))),
    low: round(mean(picks.map((p) => realised.get(p.symbol).low * 100))),
    win_rate: round(net.filter((v) => v > 0).length / (net.length || 1)),
    ic: round(spearman(liquid.map((p) => p.close), liquid.map((p) => realised.get(p.symbol).close))),
    predicted_close: picks.length && Number.isFinite(picks[0].close) && "high" in picks[0] ? round(mean(picks.map((p) => p.close * 100))) : null,
  };
}

function summarise(daily) {
  const net = daily.map((d) => d.net_return), excess = daily.map((d) => d.net_return + DAYTRADE_COST_PCT - d.market_return), ic = daily.map((d) => d.ic).filter(Number.isFinite);
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const r of net) { equity *= 1 + r / 100; peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity / peak - 1); }
  const t = (a) => (a.length > 1 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
  return {
    days: daily.length, mean_net_return: round(mean(net)), t_net: round(t(net), 2), winning_days: round(net.filter((v) => v > 0).length / daily.length),
    cumulative_return: round((equity - 1) * 100, 2), max_drawdown: round(maxDrawdown * 100, 2),
    mean_excess_vs_market: round(mean(excess)), t_excess: round(t(excess), 2),
    mean_ic: round(mean(ic)), t_ic: round(t(ic), 2), mean_high: round(mean(daily.map((d) => d.high))), mean_low: round(mean(daily.map((d) => d.low))),
  };
}

export function runBacktest(days, { log = () => {} } = {}) {
  const testDays = days.filter((_, i) => i >= DAYTRADE_TRAIN_DAYS);
  const results = Object.fromEntries(Object.keys(STRATEGIES).map((k) => [k, []]));
  testDays.forEach((day, n) => {
    const index = days.indexOf(day), history = days.slice(Math.max(0, index - DAYTRADE_TRAIN_DAYS - 5), index);
    for (const [key, strategy] of Object.entries(STRATEGIES)) {
      let predictions;
      if (strategy.score) predictions = strategy.score(day);
      else { const model = strategy.train(history); if (!model) continue; predictions = predictDaytrade(model, day); }
      results[key].push(dayResult(day, predictions));
    }
    if ((n + 1) % 10 === 0 || n + 1 === testDays.length) log(`백테스트 ${n + 1}/${testDays.length}일 (${day.date})`);
  });
  return Object.fromEntries(Object.entries(results).map(([key, daily]) => [key, { label: STRATEGIES[key].label, summary: daily.length ? summarise(daily) : null, daily }]));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2), files = [], log = createProgressLog({ label: "단타 백테스트" });
  let out = "data/daytrade/backtest.json";
  for (let i = 0; i < args.length; i++) { if (args[i] === "--bars") files.push(args[++i]); else if (args[i] === "--out") out = args[++i]; }
  const observations = [];
  for (const file of files) observations.push(...JSON.parse(await readFile(file, "utf8")).observations);
  const days = await log.phase("일별 단면 구성", () => buildDays(observations), (d) => `· ${d.length}일 (${d[0]?.date}~${d.at(-1)?.date})`);
  const strategies = runBacktest(days, { log });
  const record = { schema_version: 1, generated_at: new Date().toISOString(), assumptions: { entry: "open", exit: "close", top_n: DAYTRADE_TOP_N, min_turnover_krw: DAYTRADE_MIN_TURNOVER, round_trip_cost_pct: DAYTRADE_COST_PCT, train_days: DAYTRADE_TRAIN_DAYS, weighting: "equal" },
    period: { first: days[DAYTRADE_TRAIN_DAYS]?.date ?? null, last: days.at(-1)?.date ?? null }, notice: "Walk-forward backtest on Naver daily candles (unofficial; venue and adjustment unconfirmed). Past results do not guarantee future returns.", strategies };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  for (const [key, s] of Object.entries(strategies)) log(`${key} · ${s.label} · ${JSON.stringify(s.summary)}`);
}
