// Past-date day-trade backfill: for each date D the model is trained only on
// the sessions before D (from Naver daily candles), scored with D's stored
// 09:00 open, and settled from D's stored 1530.json, exactly like the live
// 09:00 / 15:30 steps. Files are marked "backfill".
// Usage: node scripts/daytrade-backfill.mjs --bars file.json [--bars more.json] --from YYYY-MM-DD --to YYYY-MM-DD
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RANK_FEATURE_SESSIONS } from "../providers/rank-model.js";
import { buildDays, trainDaytradeModel } from "../providers/daytrade-model.js";
import { createProgressLog } from "../providers/progress-log.js";
import { daytradeClose, daytradeOpen } from "./daytrade-signal.mjs";

export async function backfillDaytrade({ observations, from, to, log = () => {} }) {
  const days = buildDays(observations), results = [];
  for (const date of [...new Set(observations.map((o) => o.date))].filter((d) => d >= from && d <= to).sort()) {
    const model = trainDaytradeModel(days.filter((d) => d.date < date));
    if (!model) { results.push({ date, status: "no_data", reason: "not enough training sessions" }); continue; }
    // The prior 20 bars of every symbol, newest first, as the morning cache stores them.
    const prior = {};
    for (const o of observations.filter((o) => o.date < date).sort((a, b) => b.date.localeCompare(a.date))) {
      const list = (prior[o.symbol] ||= []);
      if (list.length < RANK_FEATURE_SESSIONS) list.push([o.date, o.open, o.close, o.high, o.low, o.volume]);
    }
    const opened = await daytradeOpen({ date, model, returnHistory: prior, backfill: true, log });
    const closed = opened.status === "ready" ? await daytradeClose({ date, log }) : null;
    results.push({ date, model: `${model.train_first_date}~${model.train_last_date}`, open: opened.status, close: closed?.status ?? "not_run", net_return: closed?.net_return ?? null, market_return: closed?.market_return ?? null });
  }
  return results;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2), files = [];
  let from = null, to = null;
  for (let i = 0; i < args.length; i++) { if (args[i] === "--bars") files.push(args[++i]); else if (args[i] === "--from") from = args[++i]; else if (args[i] === "--to") to = args[++i]; }
  const log = createProgressLog({ label: "단타 재계산" });
  const observations = [];
  for (const file of files) observations.push(...JSON.parse(await readFile(file, "utf8")).observations);
  for (const r of await backfillDaytrade({ observations, from, to, log })) log(JSON.stringify(r));
}
