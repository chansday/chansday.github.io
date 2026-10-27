import { deriveExpectedReturn } from "./evaluation-contract.js";

export function isDailyExperiment(x, targetDate, phase) {
  if (!x || x.status !== "experimental" || x.target_date !== targetDate || x.phase !== phase || !["before-open", "during-market"].includes(phase) || x.input_type !== "latest_available_prior_close_reference_not_quote") return false;
  const predicted = Date.parse(x.predicted_at), retrieved = Date.parse(x.history_retrieved_at), checked = Date.parse(x.robots_checked_at);
  if (![predicted, retrieved, checked].every(Number.isFinite) || checked > retrieved || retrieved > predicted || x.robots_url !== "https://aikstockdata.com/robots.txt") return false;
  const kst = new Date(predicted + 9 * 3600000).toISOString();
  if (kst.slice(0, 10) !== targetDate || (phase === "before-open" ? kst.slice(11, 19) >= "09:00:00" : kst.slice(11, 19) < "09:00:00" || kst.slice(11, 19) >= "15:30:00")) return false;
  if (!Array.isArray(x.history_dates) || x.history_dates.length !== 3 || new Set(x.history_dates).size !== 3 || !Array.isArray(x.history_urls) || x.history_urls.length !== 3 || x.source_date !== x.history_dates[0]) return false;
  if (x.history_dates.some((date, i) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= targetDate || (i && date >= x.history_dates[i - 1]) || x.history_urls[i] !== `https://aikstockdata.com/data/public/daily/quotes_${date.replaceAll("-", "")}.csv`)) return false;
  if (!Array.isArray(x.unavailable_dates) || x.unavailable_dates.length > 1 || x.stale !== (x.unavailable_dates.length > 0) || x.unavailable_dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= targetDate || x.history_dates.includes(date))) return false;
  if (x.first_publication !== "unknown" || x.revision_policy !== "unknown" || x.adjustment !== "unknown" || x.license_status !== "unconfirmed" || x.source_confirmation !== "provider_claims_final_unverified" || !Array.isArray(x.rows) || !x.rows.length) return false;
  const seen = new Set();
  return x.rows.every((row) => {
    if (!row || !/^[0-9]{6}$/.test(row.symbol) || seen.has(row.symbol) || typeof row.name !== "string" || ["expected_open", "actual_open", "actual_close", "error"].some((key) => Object.hasOwn(row, key))) return false;
    seen.add(row.symbol);
    if (row.reference_price === null) return row.estimated_close === null && row.estimated_return === null && typeof row.missing_reason === "string";
    return Number.isFinite(row.reference_price) && row.reference_price > 0 && Number.isFinite(row.estimated_close) && row.estimated_close > 0 && row.missing_reason === null && row.estimated_return === deriveExpectedReturn({ expected_open: row.reference_price, expected_close: row.estimated_close });
  });
}
