import { pathToFileURL } from "node:url";
import { collectNaverUniverse, fetchNaverQuotes } from "../providers/naver-crawl-provider.js";
import { collectNaverDailyRows } from "../providers/naver-daily-rows.js";
import { kstDate } from "./market-calendar.mjs";

// Network dry run: universe (live list, else committed list) plus quotes and
// daily bars for a few symbols. Writes no files. Same robots gate and throttle
// as the operational collectors.
export async function naverCrawlDryRun({ limit = 3, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const universe = await collectNaverUniverse({ fetchImpl, now });
  const report = {
    universe: universe.ok
      ? { status: "ok", source: universe.universeSource, endpoint: universe.universeEndpoint, as_of: universe.universeAsOf, stale: Boolean(universe.universeStale), count: universe.symbols.length, fallback_reason: universe.universeFallbackReason || null, robots: universe.robotsChecks }
      : { status: universe.blocked ? "blocked" : universe.empty ? "no_data" : "degraded", reason: universe.reason, robots: universe.robotsChecks },
  };
  if (!universe.ok) return report;
  const symbols = universe.symbols.slice(0, Math.max(1, Math.min(10, limit))).map(s => s.symbol);
  report.sample_symbols = symbols;
  const quotes = await fetchNaverQuotes(symbols, { fetchImpl, now });
  report.quotes = quotes.ok
    ? { status: "ok", rows: quotes.quotes.length, missing: quotes.missingSymbols.length, sample: quotes.quotes.map(q => ({ symbol: q.symbol, exchange: q.exchange, close: q.closePrice, open: q.openPrice, market_status: q.marketStatus, quote_at: q.quoteAt?.toISOString() || null })), robots: quotes.robotsChecks }
    : { status: quotes.blocked ? "blocked" : "degraded", reason: quotes.reason, robots: quotes.robotsChecks };
  const daily = await collectNaverDailyRows({ symbols, targetDate: kstDate(now()), fetchImpl });
  report.daily = { status: daily.status, reason: daily.reason || null, requested: daily.requested, rows: daily.observations.length, rejected: daily.rejected.length, robots_url: daily.robots_url || null, robots_status: daily.robots_status ?? null, latest: Object.fromEntries(symbols.map(s => [s, daily.observations.find(r => r.symbol === s) || null])) };
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const i = process.argv.indexOf("--limit");
  naverCrawlDryRun({ limit: i > 0 ? Number(process.argv[i + 1]) || 3 : 3 })
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
