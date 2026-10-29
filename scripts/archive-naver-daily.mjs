// Local backfill: collects the last --months (default 4) of Naver daily bars for
// every symbol in the committed KOSPI universe and writes one file per month,
// data/daily-archive/YYYY-MM.json. Uses the same robots-checked, rate-limited
// collector as the 06:10 daily history (one request per symbol, 500 ms apart).
// Bars of today are kept only after 16:00 KST, when the close is settled.
// Re-running merges into existing months; a changed bar is replaced and
// counted in `revised` so source revisions stay visible.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { collectNaverDailyRows } from "../providers/naver-daily-rows.js";
import { repoPath } from "../providers/repo-paths.js";
import { kstDate } from "./market-calendar.mjs";

const shift = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export async function archiveDaily({ months = 4, now = () => new Date(), collector = collectNaverDailyRows, log = console.log } = {}) {
  if (!Number.isInteger(months) || months < 1 || months > 5) throw new Error("--months must be 1..5 (the collector looks back 150 days)");
  const started = now(), today = kstDate(started);
  const settled = Date.parse(`${today}T16:00:00+09:00`) <= started.getTime();
  const lastDate = settled ? today : shift(today, -1);
  const firstDate = shift(lastDate, -Math.round(months * 30.5));
  const universe = JSON.parse(await readFile(repoPath("data/kospi-universe.json"), "utf8"));
  const symbols = universe.symbols.map((s) => s.symbol);
  log(`Collecting ${symbols.length} symbols, ${firstDate}..${lastDate} (about ${Math.ceil(symbols.length * 0.5 / 60)} min)`);
  const result = await collector({ symbols, targetDate: shift(lastDate, 1) });
  if (!["ready", "partial"].includes(result.status) || result.requested !== symbols.length) throw new Error(`daily collection incomplete: ${result.reason || result.status} (${result.requested}/${symbols.length})`);
  const bars = result.observations.filter((r) => r.date >= firstDate && r.date <= lastDate);
  const byMonth = new Map();
  for (const r of bars) {
    const month = r.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, {});
    (byMonth.get(month)[r.symbol] ||= []).push([r.date, r.open, r.high, r.low, r.close, r.volume]);
  }
  const rejected = (result.rejected || []).filter((r) => !r.date || (r.date >= firstDate && r.date <= lastDate));
  await mkdir(repoPath("data/daily-archive"), { recursive: true });
  const written = [];
  for (const [month, fresh] of [...byMonth].sort()) {
    const path = repoPath(`data/daily-archive/${month}.json`);
    let existing = null;
    try { existing = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const merged = {}, revised = [];
    for (const symbol of new Set([...Object.keys(existing?.bars || {}), ...Object.keys(fresh)])) {
      const map = new Map((existing?.bars?.[symbol] || []).map((b) => [b[0], b]));
      for (const b of fresh[symbol] || []) {
        const old = map.get(b[0]);
        if (old && JSON.stringify(old) !== JSON.stringify(b)) revised.push({ symbol, date: b[0], previous: old });
        map.set(b[0], b);
      }
      merged[symbol] = [...map.values()].sort((a, b) => a[0].localeCompare(b[0]));
    }
    const record = {
      schema_version: 1, source: "naver-daily", endpoint: "https://api.stock.naver.com/chart/domestic/item/{symbol}/day",
      month, retrieved_at: now().toISOString(), symbols: Object.keys(merged).length, bars_count: Object.values(merged).reduce((n, b) => n + b.length, 0),
      columns: ["date", "open", "high", "low", "close", "volume"],
      license_status: "unconfirmed", market_venue: "unconfirmed", adjustment: "unconfirmed",
      notice: "Unofficial Naver endpoint; only valid bars (positive prices and volume) are kept, so zero-volume (halted) sessions are absent and listed in rejected.",
      robots_url: result.robots_url ?? null, robots_checked_at: result.robots_checked_at ?? null,
      rejected: rejected.filter((r) => r.date?.startsWith(month)), revised: [...(existing?.revised || []), ...revised],
      bars: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))),
    };
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
    written.push({ month, symbols: record.symbols, bars: record.bars_count, revised: revised.length });
  }
  return { status: result.status, firstDate, lastDate, requested: result.requested, written };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const arg = process.argv.find((a) => a.startsWith("--months="));
  archiveDaily({ months: arg ? Number(arg.slice(9)) : 4 }).then((r) => console.log(JSON.stringify(r, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
