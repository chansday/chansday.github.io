import {
  createSourceMetadata,
  isProviderResult,
} from "./provider-adapter.js";
import { checkRobotsUrl } from "./robots-policy.js";
import { classifyMarketDate, loadMarketCalendar } from "../scripts/market-calendar.mjs";
import { deriveSessionReturn } from "./evaluation-contract.js";

const SOURCE_HOST = "aikstockdata.com";
const DEFAULT_BASE_URL = "https://aikstockdata.com/data/public/daily";
const SOURCE_NAME = "한국주식데이터 (원천: 금융위원회 공공데이터포털·한국거래소)";
const LICENSE_URL = "https://aikstockdata.com/licenses/aiksd-public-1.1.txt";
const LICENSE_STATUS = "confirmed";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_OVERALL_DEADLINE_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_AGE_HOURS = 72;
const DEFAULT_MAX_CONCURRENCY = 2;
const USER_AGENT = "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)";

function numberEnv(env, key, fallback, minimum = 0) {
  const value = Number(env[key]);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

function parseConfig(env) {
  const rawBase = (env.KOSPI_PUBLIC_CSV_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/$/, "");
  let baseUrl;
  try {
    baseUrl = new URL(rawBase);
  } catch {
    return { enabled: false, reason: "Public CSV base URL is invalid." };
  }
  if (baseUrl.protocol !== "https:" || baseUrl.hostname.toLowerCase() !== SOURCE_HOST) {
    return { enabled: false, reason: `Public CSV host must be the explicit allowlisted host ${SOURCE_HOST}.` };
  }
  return {
    enabled: true,
    baseUrl: baseUrl.toString(),
    timeoutMs: numberEnv(env, "KOSPI_PUBLIC_SOURCE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1000),
    overallDeadlineMs: numberEnv(env, "KOSPI_PUBLIC_OVERALL_DEADLINE_MS", DEFAULT_OVERALL_DEADLINE_MS, 1000),
    maxRetries: Math.min(3, numberEnv(env, "KOSPI_PUBLIC_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0)),
    retryBaseMs: Math.min(3_000, numberEnv(env, "KOSPI_PUBLIC_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS, 0)),
    maxAgeHours: numberEnv(env, "KOSPI_PUBLIC_MAX_AGE_HOURS", DEFAULT_MAX_AGE_HOURS, 1),
    maxConcurrency: Math.min(2, Math.max(1, numberEnv(env, "KOSPI_PUBLIC_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY, 1))),
  };
}

function kstParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return parts;
}

function kstDate(date) {
  const parts = kstParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function subtractDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function sourceUrl(baseUrl, date) {
  return `${baseUrl}/quotes_${date.replaceAll("-", "")}.csv`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const [headers, ...values] = rows;
  if (!headers?.length) return [];
  return values.map((valuesRow) => Object.fromEntries(headers.map((header, index) => [header, valuesRow[index] ?? ""])));
}

function parseNumeric(value) {
  const number = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function runId(env) {
  return String(env.GITHUB_RUN_ID || env.KOSPI_RUN_ID || `local-${Date.now()}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, { config, fetchImpl, deadlineAt, metrics, forecastPolicy }) {
  let attempt = 0;
  while (attempt <= config.maxRetries) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      metrics.deadlineHit = true;
      return { ok: false, reason: "overall deadline exceeded" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, remaining));
    metrics.requested += 1;
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "text/csv, text/plain;q=0.9", "User-Agent": USER_AGENT },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.ok) {
        const contentType = (response.headers?.get("content-type") || "").toLowerCase();
        if (contentType.includes("text/html")) return { ok: false, reason: "HTML response rejected; CSV-only collection is required." };
        metrics.completed += 1;
        return { ok: true, text: await response.text() };
      }
      const retryable = (!forecastPolicy && response.status === 429) || response.status >= 500;
      if (!retryable || attempt >= config.maxRetries) {
        metrics.failed += 1;
        return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
      }
      metrics.retries += 1;
      const retryAfter = Number(response.headers?.get("retry-after") || 0);
      const delay = Math.min(3_000, retryAfter > 0 ? retryAfter * 1000 : config.retryBaseMs * (2 ** attempt));
      if (Date.now() + delay >= deadlineAt) {
        metrics.deadlineHit = true;
        return { ok: false, reason: "overall deadline exceeded during retry backoff" };
      }
      await sleep(delay);
    } catch (error) {
      if (error.name === "AbortError") {
        metrics.failed += 1;
        return { ok: false, reason: "source timeout or overall deadline exceeded" };
      }
      if (attempt >= config.maxRetries) {
        metrics.failed += 1;
        return { ok: false, reason: `request failed: ${error.message}` };
      }
      metrics.retries += 1;
      const delay = Math.min(3_000, config.retryBaseMs * (2 ** attempt));
      if (Date.now() + delay >= deadlineAt) {
        metrics.deadlineHit = true;
        return { ok: false, reason: "overall deadline exceeded during retry backoff" };
      }
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
    attempt += 1;
  }
  return { ok: false, reason: "retry budget exhausted" };
}

async function fetchDate(date, context) {
  const url = sourceUrl(context.config.baseUrl, date);
  if (context.forecastPolicy) {
    const policy = await checkRobotsUrl(context, url, USER_AGENT);
    if (!policy.ok) return { date, url, found: false, blocked: true, reason: policy.reason };
    context.lastRobotsPolicy = policy;
  }
  const response = await fetchWithRetry(url, context);
  if (!response.ok) return { date, url, found: false, blocked: [403, 429].includes(response.status), reason: response.reason, status: response.status };
  const rows = parseCsv(response.text);
  const kospi = rows.filter((row) => row.mrktCtg === "KOSPI");
  const symbols = new Set();
  const validRows = [];
  let invalidRows = 0;
  for (const row of kospi) {
    const symbol = row["종목코드"];
    const name = row["종목명"];
    const open = parseNumeric(row.mkp);
    const close = parseNumeric(row.clpr);
    const volume = parseNumeric(row.trqu);
    if (!symbol || !name || row.basDt !== date.replaceAll("-", "") || open === null || close === null || volume === null || symbols.has(symbol)) {
      invalidRows += 1;
      continue;
    }
    symbols.add(symbol);
    validRows.push({ symbol, name, open, close, volume });
  }
  return { date, url, found: kospi.length > 0, rawRows: rows.length, rows: validRows, invalidRows };
}

async function fetchHistory(startDate, context, exactOnly = false) {
  const dates = Array.from({ length: 7 }, (_, index) => subtractDays(startDate, index));
  const found = [];
  for (let offset = 0; offset < dates.length && found.length < (exactOnly ? 1 : 2); offset += context.config.maxConcurrency) {
    const batch = dates.slice(offset, offset + context.config.maxConcurrency);
    const results = await Promise.all(batch.map((date) => fetchDate(date, context)));
    for (const result of results) {
      if (result.found && result.rows?.length) found.push(result);
    }
    if (context.metrics.deadlineHit) break;
  }
  found.sort((a, b) => b.date.localeCompare(a.date));
  if (exactOnly && found[0]?.date !== startDate) return { latest: null, prior: null };
  return { latest: found[0] || null, prior: found[1] || null };
}

function freshnessStatus(date, now, maxAgeHours) {
  const closeTime = new Date(`${date}T15:30:00+09:00`).getTime();
  const ageHours = Number.isFinite(closeTime) ? (now.getTime() - closeTime) / 3_600_000 : Number.POSITIVE_INFINITY;
  return ageHours >= 0 && ageHours <= maxAgeHours ? "fresh" : "stale";
}

function makeSource({ latest, context, status, partial = false }) {
  const nowIso = (context.sourceTimestamp || context.now()).toISOString();
  const elapsedMs = context.stableSnapshot ? 0 : Date.now() - context.startedAt;
  const estimatedMs = Math.min(context.config.overallDeadlineMs, Math.ceil(
    (context.metrics.completed > 0 ? elapsedMs / context.metrics.completed : context.config.timeoutMs) * Math.max(1, context.metrics.requested) / context.config.maxConcurrency,
  ));
  return createSourceMetadata({
    name: SOURCE_NAME,
    url: latest?.url || context.config.baseUrl,
    licenseStatus: LICENSE_STATUS,
    licenseUrl: LICENSE_URL,
    retrievedAt: nowIso,
    sourceId: "aikstockdata-public-daily-csv",
    runId: context.runId,
    status,
    fetchedAt: nowIso,
    sourceDate: latest?.date || null,
    rawRows: latest?.rawRows,
    sourceRows: latest?.rows?.length,
    partial,
    metrics: {
      requested: context.metrics.requested,
      completed: context.metrics.completed,
      failed: context.metrics.failed,
      retries: context.metrics.retries,
      deadline_hit: context.metrics.deadlineHit,
      elapsed_ms: elapsedMs,
      estimated_ms: estimatedMs,
      overall_deadline_ms: context.config.overallDeadlineMs,
      max_concurrency: context.config.maxConcurrency,
    },
  });
}

function noData(message, source = null, status = "no_data", asOfDate = source?.source_date || null) {
  return { status, message, rows: [], source, asOfDate };
}

function makeRows(latest, prior, { includeClose = true } = {}) {
  const rows = latest.rows.map((row) => {
    const sessionReturn = includeClose ? deriveSessionReturn({ actual_open: row.open, actual_close: row.close }) : null;
    return {
      rank: null,
      symbol: row.symbol,
      name: row.name,
      expected_open: null,
      expected_close: null,
      expected_return: null,
      actual_open: row.open,
      actual_close: includeClose ? row.close : null,
      actual_return: null,
      session_return: sessionReturn,
      actual_volume: row.volume,
      error: null,
      confidence: null,
      quality: "public_eod_observed",
      status: "valid",
    };
  });
  rows.sort((a, b) => (b.session_return ?? -Infinity) - (a.session_return ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

// A forecast crawl needs a current explicit robots decision, rather than
// treating absence, errors or another crawler's allow-list as permission.
// Fetch three prior daily files at prediction time. A missing file is recorded;
// other source failures fail closed. Never infer a missing trading session.
export async function fetchForecastHistory({ env = {}, fetchImpl = globalThis.fetch, now = () => new Date(), targetDate, maxMissingSessions = 0 }) {
  const config = parseConfig(env);
  if (!config.enabled || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || !Number.isInteger(maxMissingSessions) || maxMissingSessions < 0 || maxMissingSessions > 1) return { ok: false, reason: "history configuration invalid" };
  const startedAt = Date.now();
  const context = { config, fetchImpl, deadlineAt: startedAt + config.overallDeadlineMs,
    now, forecastPolicy: true, metrics: { requested: 0, completed: 0, failed: 0, retries: 0, deadlineHit: false } };
  const sessions = [], unavailable = [];
  let calendar;
  try { calendar = await loadMarketCalendar(); } catch (error) { return { ok: false, reason: `market calendar unavailable: ${error.message}` }; }
  const targetMarket = classifyMarketDate(targetDate, calendar);
  if (targetMarket.status !== "run") return { ok: false, reason: `calendar ${targetDate}: ${targetMarket.reason}` };
  const requestCache = new Map(); // scoped to this collection; never reused across predictions
  for (let offset = 1; offset <= 30 && sessions.length < 3; offset += 1) {
    const date = subtractDays(targetDate, offset);
    let day;
    try { day = classifyMarketDate(date, calendar); } catch (error) { return { ok: false, reason: `calendar ${date}: ${error.message}` }; }
    if (day.status === "skip") continue;
    if (day.status !== "run") return { ok: false, reason: `calendar ${date}: ${day.reason}` };
    // One request at a time; no persistent cache can leak a later revision into a previous prediction.
    if (!requestCache.has(date)) { await sleep(250); requestCache.set(date, await fetchDate(date, context)); }
    const entry = requestCache.get(date);
    if (!entry.found || !entry.rows?.length) {
      if (entry.status === 404 && unavailable.length < maxMissingSessions) { unavailable.push(date); continue; }
      return { ok: false, blocked: Boolean(entry.blocked), reason: `required trading session ${date}: ${entry.reason || "empty or invalid CSV"}` };
    }
    if (entry.invalidRows > 0) return { ok: false, reason: `history ${date}: invalid or duplicate source rows` };
    sessions.push(entry);
  }
  const retrieved = now();
  if (!(retrieved instanceof Date) || !Number.isFinite(retrieved.getTime()) || sessions.length !== 3)
    return { ok: false, reason: "fewer than three verified prior daily files" };
  return { ok: true, sessions, unavailable, retrieved_at: retrieved.toISOString(), robots_url: context.lastRobotsPolicy.robotsUrl, robots_checked_at: context.lastRobotsPolicy.checkedAt };
}

export function createPublicCsvProvider({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  targetDate = null,
  sourceTimestamp = null,
} = {}) {
  const config = parseConfig(env);
  const historicalDate = targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? targetDate : null;
  const provider = {
    id: "public-csv",
    label: "PUBLIC CSV · EOD OBSERVATION ONLY",
    status: config.enabled ? "configured" : "disabled",
    getSourceMetadata() { return null; },
    async fetchPreviousDay() { return collectObserved(provider, "previous-result", false); },
    async runAnalysis() { return collectObserved(provider, "analysis", false); },
    async generateForecast() {
      if (!config.enabled) return noData(config.reason);
      if (historicalDate) {
        const context = createContext();
        const history = await fetchHistory(historicalDate, context, true);
        const source = makeSource({ latest: history.latest, context, status: history.latest ? "historical_observed" : "no_data", partial: !history.latest });
        if (!history.latest) return noData(`No public historical KOSPI data was available for ${historicalDate}; forecast remains no_data.`, source, "no_data", historicalDate);
        return noData(
          `Unsupported: historical pre-open quote/order-book data for ${historicalDate} is unavailable; no forecast is synthesized or reconstructed.`,
          source,
          "no_data",
          historicalDate,
        );
      }
      const context = createContext();
      const history = await fetchHistory(subtractDays(kstDate(now()), 1), context);
      const freshness = history.latest ? freshnessStatus(history.latest.date, now(), config.maxAgeHours) : "stale";
      const source = makeSource({
        latest: history.latest,
        context,
        status: freshness === "stale" ? "stale" : "forecast_unsupported",
        partial: true,
      });
      if (!history.latest || context.metrics.deadlineHit) {
        return noData("Public daily CSV baseline inputs are incomplete before the forecast deadline; forecast remains no_data.", source);
      }
      if (freshness !== "fresh") {
        return noData(`Public daily CSV source date ${history.latest.date} is stale for today's forecast; no stale forecast is published.`, source, "degraded", history.latest.date);
      }
      return noData(
        `Unsupported: public-csv has no live pre-market quote/order-book data. EOD source ${history.latest.date} is recorded, but no ready forecast is published.`,
        source,
        "no_data",
        history.latest.date,
      );
    },
    async settleOpen() {
      if (!config.enabled) return noData(config.reason);
      if (historicalDate) return historicalSettlement(false);
      return noData("Public daily CSV is not published at the 09:00 open-settlement stage; actual_open remains no_data until a licensed intraday/open source is connected.");
    },
    async settleClose() {
      if (!config.enabled) return noData(config.reason);
      if (historicalDate) return historicalSettlement(true);
      const context = createContext();
      const history = await fetchHistory(kstDate(now()), context, true);
      if (!history.latest) return noData("Current-day close CSV is not available; stale previous data is not reused for close settlement.", makeSource({ latest: null, context, status: context.metrics.deadlineHit ? "deadline" : "no_data" }));
      const priorContext = createContext();
      const prior = await fetchHistory(subtractDays(history.latest.date, 1), priorContext, true);
      const freshness = freshnessStatus(history.latest.date, now(), config.maxAgeHours);
      if (freshness !== "fresh" || context.metrics.deadlineHit || history.latest.invalidRows > 0 || !prior.latest) {
        return noData("Current-day CSV is stale, partial, missing its prior-session input, or past the collection deadline; no stale snapshot is reused.", makeSource({ latest: history.latest, context, status: freshness === "stale" ? "stale" : "partial", partial: true }), freshness === "stale" ? "degraded" : "partial", history.latest.date);
      }
      return {
        status: "ready",
        message: `Observed ${history.latest.rows.length} KOSPI rows for ${history.latest.date}; no pre-market estimate is inferred.`,
        rows: makeRows(history.latest, prior.latest),
        source: makeSource({ latest: history.latest, context, status: "ready" }),
        asOfDate: history.latest.date,
      };
    },
  };

  function createContext() {
    const startedAt = Date.now();
    return {
      config,
      fetchImpl,
      now,
      sourceTimestamp: sourceTimestamp ? new Date(sourceTimestamp) : null,
      targetDate: historicalDate,
      runId: runId(env),
      stableSnapshot: env.KOSPI_STABLE_SNAPSHOT === "1",
      startedAt,
      deadlineAt: startedAt + config.overallDeadlineMs,
      metrics: { requested: 0, completed: 0, failed: 0, retries: 0, deadlineHit: false },
    };
  }

  async function collectObserved(currentProvider, stage, exactOnly) {
    if (!config.enabled) return noData(config.reason);
    const context = createContext();
    const basisDate = historicalDate || kstDate(now());
    const startDate = exactOnly ? basisDate : subtractDays(basisDate, 1);
    const history = await fetchHistory(startDate, context, exactOnly);
    if (!history.latest) return noData(`No public KOSPI CSV was available before the ${stage} deadline; no stale snapshot is reused.`, makeSource({ latest: null, context, status: context.metrics.deadlineHit ? "deadline" : "no_data" }));
    const freshness = historicalDate ? "fresh" : freshnessStatus(history.latest.date, now(), config.maxAgeHours);
    const partial = context.metrics.deadlineHit || history.latest.invalidRows > 0 || !history.prior;
    const sourceStatus = freshness === "stale" ? "stale" : partial ? "partial" : "ready";
    if (freshness !== "fresh" || partial) return noData(`Public CSV is ${sourceStatus}; partial or stale data is not published as a normal ranking.`, makeSource({ latest: history.latest, context, status: sourceStatus, partial: true }), freshness === "stale" ? "degraded" : "partial", history.latest.date);
    const rows = makeRows(history.latest, history.prior);
    return {
      status: "ready",
      message: `Observed ${rows.length} KOSPI rows from the public daily CSV for ${history.latest.date}; expected fields remain null.`,
      rows,
      source: makeSource({ latest: history.latest, context, status: "ready" }),
      asOfDate: history.latest.date,
    };
  }

  async function historicalSettlement(includeClose) {
    const context = createContext();
    const history = await fetchHistory(historicalDate, context, true);
    if (!history.latest) {
      return noData(`No public historical KOSPI data was available for ${historicalDate}; ${includeClose ? "close" : "open"} settlement remains no_data.`, makeSource({ latest: null, context, status: context.metrics.deadlineHit ? "degraded" : "no_data" }), context.metrics.deadlineHit ? "degraded" : "no_data", historicalDate);
    }
    const priorContext = createContext();
    const prior = await fetchHistory(subtractDays(historicalDate, 1), priorContext, true);
    if (!prior.latest || history.latest.invalidRows > 0 || prior.latest.invalidRows > 0 || context.metrics.deadlineHit || priorContext.metrics.deadlineHit) {
      return noData(
        `Historical ${includeClose ? "close" : "open"} settlement for ${historicalDate} is partial or missing its prior-session input; no values are inferred.`,
        makeSource({ latest: history.latest, context, status: "partial", partial: true }),
        "partial",
        historicalDate,
      );
    }
    const rows = makeRows(history.latest, prior.latest, { includeClose });
    return {
      status: "ready",
      message: `Observed ${rows.length} KOSPI rows from the public historical daily CSV for ${historicalDate}; no pre-market estimate is inferred.`,
      rows,
      source: makeSource({ latest: history.latest, context, status: "ready" }),
      asOfDate: historicalDate,
    };
  }

  if (!config.enabled) provider.getSourceMetadata = () => null;
  return provider;
}
