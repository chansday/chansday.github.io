// Day-trade signal file data/daytrade/D.json.
//   open  (after the 09:00 open-settlement): scores every symbol with the day's
//         actual open, the prior 20 bars of the morning cache and the model the
//         collector trained, and records the top DAYTRADE_TOP_N liquid picks.
//   close (after the 15:30 close-settlement): adds the picks' realised
//         open->close, high and low, net of cost, and appends to ledger.json.
// Usage: node scripts/daytrade-signal.mjs open|close [--date YYYY-MM-DD]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { kstDate } from "./market-calendar.mjs";
import { DAYTRADE_COST_PCT, DAYTRADE_MIN_TURNOVER, DAYTRADE_TOP_N, daytradeCrossSection, daytradePicks, isDaytradeModel, predictDaytrade } from "../providers/daytrade-model.js";
import { createProgressLog } from "../providers/progress-log.js";
import { repoPath } from "../providers/repo-paths.js";

const pct = (v) => Math.round(v * 1e6) / 1e4;
const round = (v, d = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const readJson = async (path) => { try { return JSON.parse(await readFile(repoPath(path), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const writeJson = async (path, value) => { await mkdir(repoPath("data/daytrade"), { recursive: true }); await writeFile(repoPath(path), `${JSON.stringify(value, null, 2)}\n`, "utf8"); };

export async function daytradeOpen({ date, now = () => new Date(), log = () => {} }) {
  const cache = await readJson(`data/daily-history/${date}.json`), stage = await readJson(`data/runs/${date}/0900.json`);
  if (!cache || !isDaytradeModel(cache.daytrade_model)) return { status: "no_data", reason: "morning cache has no day-trade model" };
  if (!stage || stage.meta?.run_date !== date || stage.meta?.run_stage !== "open-settlement") return { status: "no_data", reason: "no 09:00 open-settlement file for the date" };
  const names = new Map(stage.rows.map((r) => [r.symbol, r.name]));
  const inputs = stage.rows.filter((r) => r.actual_open > 0 && Array.isArray(cache.return_history?.[r.symbol]) && cache.return_history[r.symbol].length === 20)
    .map((r) => ({ symbol: r.symbol, open: r.actual_open, prior: cache.return_history[r.symbol].map(([d, open, close, high, low, volume]) => ({ date: d, open, close, high, low, volume })) }));
  const day = daytradeCrossSection(inputs);
  const predictions = predictDaytrade(cache.daytrade_model, day);
  const picks = daytradePicks(predictions).map((p, i) => ({ rank: i + 1, symbol: p.symbol, name: names.get(p.symbol) ?? p.symbol, open_gap: pct(p.gap), expected_close: pct(p.close), expected_high: pct(p.high), expected_low: pct(p.low), turnover_krw: Math.round(p.turnover) }));
  const m = cache.daytrade_model;
  const record = { schema_version: 1, date, generated_at: now().toISOString(), model: { id: m.model, train_first_date: m.train_first_date, train_last_date: m.train_last_date }, assumptions: { entry: "open", exit: "close", top_n: DAYTRADE_TOP_N, min_turnover_krw: DAYTRADE_MIN_TURNOVER, round_trip_cost_pct: DAYTRADE_COST_PCT }, market_gap: pct(day.marketGap), scored: predictions.length, picks, result: null,
    notice: "09:00 score from the actual open; for information only, not investment advice. Returns are not guaranteed." };
  await writeJson(`data/daytrade/${date}.json`, record);
  log(`시가 기준 점수 · ${predictions.length}종목 채점 · 시장 갭 ${record.market_gap}% · 상위 ${picks.length}: ${picks.slice(0, 5).map((p) => `${p.name} ${p.expected_close}%`).join(", ")}…`);
  return { status: "ready", picks: picks.length };
}

export async function daytradeClose({ date, log = () => {} }) {
  const record = await readJson(`data/daytrade/${date}.json`), stage = await readJson(`data/runs/${date}/1530.json`);
  if (!record?.picks?.length) return { status: "no_data", reason: "no day-trade picks for the date" };
  if (!stage || stage.meta?.run_date !== date || stage.meta?.run_stage !== "close-settlement") return { status: "no_data", reason: "no 15:30 close-settlement file for the date" };
  const rows = new Map(stage.rows.map((r) => [r.symbol, r]));
  const picks = record.picks.map((p) => {
    const r = rows.get(p.symbol), ok = r?.actual_open > 0 && r?.actual_close > 0;
    return { ...p, actual_close: ok ? pct(r.actual_close / r.actual_open - 1) : null, actual_high: ok && r.actual_high > 0 ? pct(r.actual_high / r.actual_open - 1) : null, actual_low: ok && r.actual_low > 0 ? pct(r.actual_low / r.actual_open - 1) : null };
  });
  const settled = picks.filter((p) => p.actual_close !== null), net = settled.map((p) => p.actual_close - DAYTRADE_COST_PCT);
  const all = stage.rows.filter((r) => r.actual_open > 0 && r.actual_close > 0).map((r) => (r.actual_close / r.actual_open - 1) * 100);
  const result = { settled: settled.length, net_return: round(mean(net)), win_rate: round(net.filter((v) => v > 0).length / (net.length || 1)), market_return: round(mean(all)), mean_high: round(mean(settled.map((p) => p.actual_high).filter(Number.isFinite))), mean_low: round(mean(settled.map((p) => p.actual_low).filter(Number.isFinite))) };
  await writeJson(`data/daytrade/${date}.json`, { ...record, picks, result });
  const ledger = (await readJson("data/daytrade/ledger.json")) || { schema_version: 1, days: [] };
  ledger.days = [...ledger.days.filter((d) => d.date !== date), { date, ...result }].sort((a, b) => a.date.localeCompare(b.date));
  await writeJson("data/daytrade/ledger.json", ledger);
  log(`마감 결과 · ${settled.length}종목 · 비용 후 평균 ${result.net_return}% · 이긴 종목 ${Math.round(result.win_rate * 100)}% · 시장 평균 ${result.market_return}%`);
  return { status: "ready", ...result };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [mode, flag, value] = process.argv.slice(2), date = flag === "--date" ? value : kstDate();
  const log = createProgressLog({ label: `단타 신호 ${date}` });
  log(`시작 · ${mode}`);
  (mode === "open" ? daytradeOpen({ date, log }) : mode === "close" ? daytradeClose({ date, log }) : Promise.reject(new Error("mode must be open or close")))
    .then((result) => { log(`종료 · ${result.status}${result.reason ? ` (${result.reason})` : ""}`); console.log(JSON.stringify(result)); })
    .catch((error) => { console.error(`Day-trade signal failed: ${error.message}`); process.exitCode = 1; });
}
