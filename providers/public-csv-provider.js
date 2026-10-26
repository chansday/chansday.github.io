import {
  createSourceMetadata,
  isProviderResult,
} from "./provider-adapter.js";

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
const DEFAULT_FORECAST_CUTOFF = "08:29:00";
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
  const cutoff = (env.KOSPI_PUBLIC_FORECAST_CUTOFF_KST || DEFAULT_FORECAST_CUTOFF).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(cutoff)) {
    return { enabled: false, reason: "Forecast cutoff must be HH:MM:SS in KST." };
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
    forecastCutoff: cutoff,
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
  const value = new Date(`${date}T00:00:00+09:00`);
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

function kstCutoffPassed(now, cutoff) {
  const parts = kstParts(now);
  return `${parts.hour}:${parts.minute}:${parts.second}` >= cutoff;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, { config, fetchImpl, deadlineAt, metrics }) {
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
      const retryable = response.status === 429 || response.status >= 500;
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
  const response = await fetchWithRetry(url, context);
  if (!response.ok) return { date, url, found: false, reason: response.reason, status: response.status };
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
  return Number.isFinite(closeTime) && (now.getTime() - closeTime) / 3_600_000 <= maxAgeHours ? "fresh" : "stale";
}

function makeSource({ latest, context, status, partial = false }) {
  const nowIso = context.now().toISOString();
  const elapsedMs = Date.now() - context.startedAt;
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

function noData(message, source = null, status = "no_data") {
  return { status, message, rows: [], source, asOfDate: null };
}

function makeRows(latest, prior) {
  const priorBySymbol = new Map((prior?.rows || []).map((row) => [row.symbol, row]));
  const rows = latest.rows.map((row) => {
    const previous = priorBySymbol.get(row.symbol);
    const actualReturn = previous?.close > 0 ? Math.round(((row.close / previous.close - 1) * 100 + Number.EPSILON) * 100) / 100 : null;
    return {
      rank: null,
      symbol: row.symbol,
      name: row.name,
      expected_open: null,
      expected_close: null,
      expected_return: null,
      actual_open: row.open,
      actual_close: row.close,
      actual_return: actualReturn,
      actual_volume: row.volume,
      error: null,
      confidence: null,
      quality: "public_eod_observed",
      status: "valid",
    };
  });
  rows.sort((a, b) => (b.actual_return ?? -Infinity) - (a.actual_return ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

function makeForecastRows(latest, prior) {
  const rows = latest.rows.map((row) => {
    const expectedOpen = row.close;
    const expectedReturn = 0;
    return {
      rank: null,
      symbol: row.symbol,
      name: row.name,
      expected_open: expectedOpen,
      expected_close: null,
      expected_return: expectedReturn,
      actual_open: null,
      actual_close: null,
      actual_return: null,
      actual_volume: null,
      prior_close: row.close,
      error: null,
      confidence: null,
      quality: "public_baseline_no_preopen_quote",
      status: "valid",
    };
  }).filter(Boolean);
  rows.sort((a, b) => (b.expected_return ?? -Infinity) - (a.expected_return ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

export function createPublicCsvProvider({ env = globalThis.process?.env || {}, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const config = parseConfig(env);
  const provider = {
    id: "public-csv",
    label: "PUBLIC CSV · EOD OBSERVATION ONLY",
    status: config.enabled ? "configured" : "disabled",
    getSourceMetadata() { return null; },
    async fetchPreviousDay() { return collectObserved(provider, "previous-result", false); },
    async runAnalysis() { return collectObserved(provider, "analysis", false); },
    async generateForecast() {
      if (!config.enabled) return noData(config.reason);
      if (kstCutoffPassed(now(), config.forecastCutoff)) return noData(`Forecast collection cutoff ${config.forecastCutoff} KST has passed; no late data is used and forecast remains no_data.`);
      const context = createContext();
      const history = await fetchHistory(subtractDays(kstDate(now()), 1), context);
      const source = makeSource({ latest: history.latest, context, status: "forecast_unavailable", partial: true });
      if (!history.latest || context.metrics.deadlineHit) return noData("Public daily CSV baseline inputs are incomplete before the forecast deadline; forecast remains no_data.", source);
      const rows = makeForecastRows(history.latest, history.prior);
      if (rows.length === 0) return noData("Public daily CSV has no overlapping prior-session rows for a baseline forecast.", source);
      return {
        status: "ready",
        message: `Generated ${rows.length} baseline expected_open rows from daily CSV through ${history.latest.date}; pre-market quote/order-book fields are unavailable.`,
        rows,
        source: makeSource({ latest: history.latest, context, status: "ready" }),
        asOfDate: kstDate(now()),
      };
    },
    async settleOpen() {
      if (!config.enabled) return noData(config.reason);
      return noData("Public daily CSV is not published at the 09:00 open-settlement stage; actual_open remains no_data until a licensed intraday/open source is connected.");
    },
    async settleClose() {
      if (!config.enabled) return noData(config.reason);
      const context = createContext();
      const history = await fetchHistory(kstDate(now()), context, true);
      if (!history.latest) return noData("Current-day close CSV is not available; stale previous data is not reused for close settlement.", makeSource({ latest: null, context, status: context.metrics.deadlineHit ? "deadline" : "no_data" }));
      const priorContext = createContext();
      const prior = await fetchHistory(subtractDays(history.latest.date, 1), priorContext, true);
      const freshness = freshnessStatus(history.latest.date, now(), config.maxAgeHours);
      if (freshness !== "fresh" || context.metrics.deadlineHit || history.latest.invalidRows > 0) {
        return noData("Current-day CSV is stale, partial, or past the collection deadline; no stale snapshot is reused.", makeSource({ latest: history.latest, context, status: freshness === "stale" ? "stale" : "partial", partial: true }), freshness === "stale" ? "degraded" : "partial");
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
      runId: runId(env),
      startedAt,
      deadlineAt: startedAt + config.overallDeadlineMs,
      metrics: { requested: 0, completed: 0, failed: 0, retries: 0, deadlineHit: false },
    };
  }

  async function collectObserved(currentProvider, stage, exactOnly) {
    if (!config.enabled) return noData(config.reason);
    const context = createContext();
    const startDate = exactOnly ? kstDate(now()) : subtractDays(kstDate(now()), 1);
    const history = await fetchHistory(startDate, context, exactOnly);
    if (!history.latest) return noData(`No public KOSPI CSV was available before the ${stage} deadline; no stale snapshot is reused.`, makeSource({ latest: null, context, status: context.metrics.deadlineHit ? "deadline" : "no_data" }));
    const freshness = freshnessStatus(history.latest.date, now(), config.maxAgeHours);
    const partial = context.metrics.deadlineHit || history.latest.invalidRows > 0 || !history.prior;
    const sourceStatus = freshness === "stale" ? "stale" : partial ? "partial" : "ready";
    if (freshness !== "fresh" || partial) return noData(`Public CSV is ${sourceStatus}; partial or stale data is not published as a normal ranking.`, makeSource({ latest: history.latest, context, status: sourceStatus, partial: true }), freshness === "stale" ? "degraded" : "partial");
    const rows = makeRows(history.latest, history.prior);
    return {
      status: "ready",
      message: `Observed ${rows.length} KOSPI rows from the public daily CSV for ${history.latest.date}; expected fields remain null.`,
      rows,
      source: makeSource({ latest: history.latest, context, status: "ready" }),
      asOfDate: history.latest.date,
    };
  }

  if (!config.enabled) provider.getSourceMetadata = () => null;
  return provider;
}
