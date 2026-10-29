import { isKoreanSymbol } from "./korean-symbol.js";
import { isValidDate } from "../scripts/market-calendar.mjs";
import { checkRobotsUrl } from "./robots-policy.js";

// Daily bars come from api.stock.naver.com (robots.txt: HTTP 404, no rules).
// m.stock.naver.com disallows all paths and is not requested.
export const DAILY_CHART_ENDPOINT = "https://api.stock.naver.com/chart/domestic/item/";
const USER_AGENT = "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)";
const LOOKBACK_DAYS = 21;

function compactDate(isoDate) { return isoDate.replaceAll("-", ""); }
function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Request only dates before the target date; the target session is never asked for.
export function dailyChartUrl(symbol, targetDate) {
  if (!isKoreanSymbol(symbol) || !isValidDate(targetDate)) throw new Error("Invalid daily chart request");
  return `${DAILY_CHART_ENDPOINT}${symbol}/day?startDateTime=${compactDate(shiftDate(targetDate, -LOOKBACK_DAYS))}0000&endDateTime=${compactDate(shiftDate(targetDate, -1))}2359`;
}

// Chart values are JSON numbers (e.g. 209000.0). Accept only finite,
// non-negative safe integers; strings, fractions and negatives are rejected.
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Interpret the observed, unofficial endpoint conservatively. Market venue,
// adjustment policy and redistribution rights have not been established. The
// chart rows carry no previous-close comparison, so every accepted row is
// recorded as comparison "unverified"; OHLC is never derived or modified.
export function parseNaverChartDailyRows(payload, { symbol, targetDate }) {
  if (!isKoreanSymbol(symbol) || !isValidDate(targetDate) || !Array.isArray(payload)) throw new Error("Invalid daily history input");
  const dates = new Set(), accepted = [], rejected = [];
  let previous = null;
  for (const raw of payload) {
    const compact = raw?.localDate;
    if (typeof compact !== "string" || !/^\d{8}$/.test(compact)) throw new Error("Daily dates must be valid, unique and ascending");
    const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    if (!isValidDate(date) || dates.has(date) || (previous && date <= previous)) throw new Error("Daily dates must be valid, unique and ascending");
    dates.add(date); previous = date;
    if (date > targetDate) throw new Error("Future daily date in source");
    if (date === targetDate) continue;
    const open = integer(raw.openPrice), close = integer(raw.closePrice), high = integer(raw.highPrice), low = integer(raw.lowPrice), volume = integer(raw.accumulatedTradingVolume);
    // A JSON number 0 for volume is the source reporting no trade (e.g. a
    // halted symbol); a missing or malformed volume stays invalid_ohlcv.
    if (!(open > 0 && close > 0 && high >= Math.max(open, close) && low > 0 && low <= Math.min(open, close) && volume > 0)) { rejected.push({ date, reason: raw.accumulatedTradingVolume === 0 ? "zero_volume" : "invalid_ohlcv" }); continue; }
    accepted.push({ symbol, date, open, high, low, close, volume, comparison: "unverified" });
  }
  accepted.reverse(); // newest first, matching the cache consumer
  return { rows: accepted, rejected, warnings: [], market_venue: "unconfirmed", adjustment: "unconfirmed", license_status: "unconfirmed" };
}

function challengeBody(body) {
  try { JSON.parse(body); return false; } catch { return /captcha|challenge|access denied/i.test(String(body || "")); }
}

// This collector has no automatic retry. 429 or Retry-After stops at once
// (no waiting) and records retry_not_before; no further requests are made. Each
// request URL is checked against robots.txt first; a denial or an unavailable
// policy (other than HTTP 404/410) stops the collection as blocked.
export async function collectNaverDailyRows({ symbols, targetDate, fetchImpl = fetch, clock = Date.now, sleep = (ms) => new Promise(r => setTimeout(r, ms)), intervalMs = 500, deadline = Infinity, now = () => new Date() }) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.some(s => !isKoreanSymbol(s)) || new Set(symbols).size !== symbols.length || !isValidDate(targetDate) || intervalMs < 500) throw new Error("Invalid collection configuration");
  const started = clock(), observations = [], rejected = [], warnings = [], durations = [];
  const robotsContext = { fetchImpl, now };
  let last = null, robots = null;
  for (const symbol of symbols) {
    const url = dailyChartUrl(symbol, targetDate);
    const policy = await checkRobotsUrl(robotsContext, url, USER_AGENT, { allowMissing: true });
    if (!policy.ok) return { status: "blocked", reason: `robots: ${policy.reason}`, robots_url: policy.robotsUrl, observations, rejected, requested: durations.length, durations_ms: durations };
    robots ||= { robots_url: policy.robotsUrl, robots_status: policy.missing ? policy.robotsStatus : 200, robots_checked_at: policy.checkedAt };
    if (last !== null) await sleep(Math.max(0, intervalMs - (clock() - last)));
    if (clock() >= deadline) return { status: "degraded", reason: "collection_deadline", observations, rejected, requested: durations.length, durations_ms: durations, ...robots };
    last = clock();
    let response, body;
    try {
      response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - clock()))) });
      body = await response.text();
    } catch (error) { return { status: "degraded", reason: `request_failed: ${error.name}`, observations, rejected, requested: durations.length + 1, durations_ms: durations, ...robots }; }
    durations.push(clock() - last);
    const retry = response.headers?.get?.("retry-after");
    if (response.status === 429 || retry) {
      const until = retry ? (/^\d+$/.test(retry.trim()) ? clock() + Number(retry) * 1000 : Date.parse(retry)) : NaN;
      return { status: "blocked", reason: response.status === 429 ? "rate_limited" : "retry_after", retry_not_before: Number.isFinite(until) ? new Date(until).toISOString() : null, observations, rejected, requested: durations.length, durations_ms: durations, ...robots };
    }
    if (response.status === 403 || (response.status >= 300 && response.status < 400) || /text\/html/i.test(response.headers?.get?.("content-type") || "") || challengeBody(body)) return { status: "blocked", reason: `source_block_${response.status}`, observations, rejected, requested: durations.length, durations_ms: durations, ...robots };
    if (response.status !== 200) return { status: "degraded", reason: `http_${response.status}`, observations, rejected, requested: durations.length, durations_ms: durations, ...robots };
    try {
      const parsed = parseNaverChartDailyRows(JSON.parse(body), { symbol, targetDate });
      if (parsed.rows.length < 3) rejected.push({ symbol, reason: "insufficient_prior_rows" });
      observations.push(...parsed.rows); rejected.push(...parsed.rejected.map(item => ({ symbol, ...item })));
      warnings.push(...parsed.warnings);
    } catch { rejected.push({ symbol, reason: "invalid_response" }); }
  }
  return { status: rejected.length ? "partial" : "ready", observations, rejected, warnings, requested: durations.length, durations_ms: durations, elapsed_ms: clock() - started, market_venue: "unconfirmed", adjustment: "unconfirmed", license_status: "unconfirmed", ...robots };
}
