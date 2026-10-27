import { fetchForecastHistory } from "./public-csv-provider.js";
import { deriveExpectedReturn } from "./evaluation-contract.js";

// Isolated research output: never an operational snapshot or a quote source.
function kstParts(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
}
function contextAt(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const p = kstParts(date), time = `${p.hour}:${p.minute}:${p.second}`;
  return { date: `${p.year}-${p.month}-${p.day}`, phase: time < "09:00:00" ? "before-open" : time < "15:30:00" ? "during-market" : "after-close" };
}
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function createDailyBaselineExperiment({ targetDate, env = {}, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const start = now(), context = contextAt(start);
  if (!context || context.date !== targetDate || context.phase === "after-close") return { status: "no_data", reason: "Only the actual current trading date before market close is eligible; past forecasts cannot be reconstructed.", rows: [] };
  const history = await fetchForecastHistory({ env, fetchImpl, now, targetDate, maxMissingSessions: 1 });
  if (!history.ok) return { status: history.blocked ? "blocked" : "no_data", reason: history.reason, rows: [] };
  const end = now(), finished = contextAt(end), retrieved = Date.parse(history.retrieved_at);
  if (!finished || finished.date !== targetDate || finished.phase !== context.phase || end < start || !Number.isFinite(retrieved) || retrieved > end.getTime()) return { status: "no_data", reason: "Collection time or market phase changed; no forecast is created.", rows: [] };
  const previous = history.sessions[0], maps = history.sessions.map((session) => new Map(session.rows.map((row) => [row.symbol, row])));
  const rows = previous.rows.map((item) => {
    const observations = maps.map((map) => map.get(item.symbol));
    const valid = /^[0-9]{6}$/.test(item.symbol) && observations.every((row) => row && row.open > 0 && row.close > 0 && row.volume > 0);
    const baseline = valid ? item.close : null;
    const average = valid ? observations.reduce((sum, row) => sum + (row.close / row.open - 1), 0) / 3 : null;
    const close = valid ? round(baseline * (1 + average)) : null;
    const usable = close > 0;
    return { symbol: item.symbol, name: item.name, reference_price: usable ? baseline : null, estimated_close: usable ? close : null,
      estimated_return: usable ? deriveExpectedReturn({ expected_open: baseline, expected_close: close }) : null,
      missing_reason: usable ? null : "missing_or_inactive_history" };
  });
  rows.sort((a, b) => (b.estimated_return ?? -Infinity) - (a.estimated_return ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  return { status: "experimental", target_date: targetDate, phase: context.phase, predicted_at: end.toISOString(),
    input_type: "latest_available_prior_close_reference_not_quote", source_date: previous.date,
    stale: history.unavailable.length > 0, unavailable_dates: history.unavailable, history_dates: history.sessions.map((s) => s.date),
    history_urls: history.sessions.map((s) => s.url), history_retrieved_at: history.retrieved_at,
    robots_url: history.robots_url, robots_checked_at: history.robots_checked_at,
    first_publication: "unknown", revision_policy: "unknown", adjustment: "unknown", license_status: "unconfirmed", source_confirmation: "provider_claims_final_unverified",
    note: "Experimental prior-close reference, not an expected opening auction quote or current price; observed data collected now, prior availability and revisions unknown. KOSPI rows may include preferred shares. Not an operational snapshot.", rows };
}
