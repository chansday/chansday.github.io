import {
  createSourceMetadata,
} from "./provider-adapter.js";

const QUOTE_ENDPOINT = "https://polling.finance.naver.com/api/realtime/domestic/stock/";
const UNIVERSE_ENDPOINT = "https://m.stock.naver.com/api/stocks/marketValue/KOSPI";
const SOURCE_NAME = "네이버 금융 공개 polling 웹 크롤링 (비공식·지연 가능)";
const SOURCE_ID = "naver-public-polling-crawl";
const USER_AGENT = "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_OVERALL_DEADLINE_MS = 120_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_AGE_SECONDS = 180;
const DEFAULT_CLOSE_MAX_AGE_SECONDS = 86_400;
const DEFAULT_UNIVERSE_PAGE_SIZE = 100;
const DEFAULT_QUOTE_BATCH_SIZE = 100;
const DEFAULT_REQUEST_INTERVAL_MS = 250;

function numberEnv(env, key, fallback, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  const value = Number(env[key]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function readConfig(env) {
  const timeoutMs = numberEnv(env, "KOSPI_CRAWL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 30_000);
  const overallDeadlineMs = numberEnv(env, "KOSPI_CRAWL_OVERALL_DEADLINE_MS", DEFAULT_OVERALL_DEADLINE_MS, timeoutMs, 300_000);
  return {
    timeoutMs,
    overallDeadlineMs,
    maxRetries: numberEnv(env, "KOSPI_CRAWL_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0, 2),
    retryBaseMs: numberEnv(env, "KOSPI_CRAWL_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS, 0, 3_000),
    maxAgeSeconds: numberEnv(env, "KOSPI_CRAWL_MAX_AGE_SECONDS", DEFAULT_MAX_AGE_SECONDS, 1, 86_400),
    closeMaxAgeSeconds: numberEnv(env, "KOSPI_CRAWL_CLOSE_MAX_AGE_SECONDS", DEFAULT_CLOSE_MAX_AGE_SECONDS, 1, 172_800),
    universePageSize: numberEnv(env, "KOSPI_CRAWL_UNIVERSE_PAGE_SIZE", DEFAULT_UNIVERSE_PAGE_SIZE, 1, 100),
    quoteBatchSize: numberEnv(env, "KOSPI_CRAWL_QUOTE_BATCH_SIZE", DEFAULT_QUOTE_BATCH_SIZE, 1, 100),
    requestIntervalMs: numberEnv(env, "KOSPI_CRAWL_REQUEST_INTERVAL_MS", DEFAULT_REQUEST_INTERVAL_MS, 0, 10_000),
  };
}

function runId(env) {
  return String(env.GITHUB_RUN_ID || env.KOSPI_RUN_ID || `local-${Date.now()}`);
}

function kstParts(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
}

function kstDate(date) {
  const parts = kstParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function resolveCrawlStage(date) {
  const parts = kstParts(date);
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  if (time < "09:00:00") return "before-open";
  if (time < "15:30:00") return "during-market";
  return "after-close";
}

function parseNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parseLocalTradedAt(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (/^\d{14}(?:\d+)?$/.test(digits)) {
    const base = digits.slice(0, 14);
    const iso = `${base.slice(0, 4)}-${base.slice(4, 6)}-${base.slice(6, 8)}T${base.slice(8, 10)}:${base.slice(10, 12)}:${base.slice(12, 14)}+09:00`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizedSymbol(value) {
  const raw = String(value ?? "").trim().replace(/^KOSPI:/i, "");
  return /^\d{6}$/.test(raw) ? raw : null;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) || response.headers?.[name] || "";
}

function isChallenge(text, contentType = "") {
  if (contentType.includes("text/html")) return true;
  return /captcha|challenge|access denied|forbidden|too many requests|robot/i.test(String(text || ""));
}

async function readResponseBody(response) {
  if (typeof response.text === "function") return response.text();
  if (typeof response.json === "function") return JSON.stringify(await response.json());
  return "";
}

async function fetchJson(url, context, { retryRateLimit = false } = {}) {
  for (let attempt = 0; attempt <= context.config.maxRetries; attempt += 1) {
    const remaining = context.deadlineAt - Date.now();
    if (remaining <= 0) {
      context.metrics.deadline_hit = true;
      return { ok: false, status: null, reason: "overall deadline exceeded" };
    }
    await sleep(context.lastRequestAt === null ? 0 : Math.max(0, context.config.requestIntervalMs - (Date.now() - context.lastRequestAt)));
    context.lastRequestAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(context.config.timeoutMs, remaining));
    context.metrics.requested += 1;
    try {
      const response = await context.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        redirect: "error",
        signal: controller.signal,
      });
      const contentType = responseHeader(response, "content-type").toLowerCase();
      const body = await readResponseBody(response);
      if (response.status === 403 || response.status === 429 || isChallenge(body, contentType)) {
        context.metrics.failed += 1;
        return { ok: false, status: response.status, blocked: true, reason: response.status === 429 ? "HTTP 429 rate limit" : response.status === 403 ? "HTTP 403 forbidden" : "Naver challenge/HTML response" };
      }
      if (response.ok) {
        context.metrics.completed += 1;
        try {
          return { ok: true, status: response.status, payload: JSON.parse(body) };
        } catch {
          context.metrics.failed += 1;
          return { ok: false, status: response.status, blocked: true, reason: "Naver response was not valid JSON" };
        }
      }
      const retryable = response.status >= 500 || (retryRateLimit && response.status === 429);
      if (!retryable || attempt >= context.config.maxRetries) {
        context.metrics.failed += 1;
        return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
      }
      context.metrics.retries += 1;
      const delay = Math.min(3_000, context.config.retryBaseMs * (2 ** attempt));
      if (Date.now() + delay >= context.deadlineAt) {
        context.metrics.deadline_hit = true;
        return { ok: false, status: response.status, reason: "overall deadline exceeded during retry backoff" };
      }
      await sleep(delay);
    } catch (error) {
      if (attempt >= context.config.maxRetries) {
        context.metrics.failed += 1;
        return { ok: false, status: null, reason: error.name === "AbortError" ? "source timeout or overall deadline exceeded" : `request failed: ${error.message}` };
      }
      context.metrics.retries += 1;
      await sleep(Math.min(3_000, context.config.retryBaseMs * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: null, reason: "retry budget exhausted" };
}

async function fetchUniverse(context) {
  const firstUrl = `${UNIVERSE_ENDPOINT}?sortType=marketValue&category=KOSPI&page=1&pageSize=${context.config.universePageSize}`;
  const first = await fetchJson(firstUrl, context);
  if (!first.ok) return first;
  if (!first.payload || !Array.isArray(first.payload.stocks)) return { ok: false, empty: true, reason: "KOSPI universe response was empty or malformed" };
  const totalCount = Number(first.payload.totalCount);
  const pageCount = Number.isFinite(totalCount) && totalCount > 0 ? Math.ceil(totalCount / context.config.universePageSize) : 1;
  const stocks = [...first.payload.stocks];
  for (let page = 2; page <= pageCount; page += 1) {
    const url = `${UNIVERSE_ENDPOINT}?sortType=marketValue&category=KOSPI&page=${page}&pageSize=${context.config.universePageSize}`;
    const response = await fetchJson(url, context);
    if (!response.ok) return response;
    if (!Array.isArray(response.payload?.stocks) || response.payload.stocks.length === 0) break;
    stocks.push(...response.payload.stocks);
  }
  const symbols = [];
  const seen = new Set();
  for (const stock of stocks) {
    const symbol = normalizedSymbol(stock.itemCode || stock.reutersCode);
    const isKospiStock = String(stock.sosok ?? "0") === "0" && String(stock.stockEndType || "stock").toLowerCase() === "stock";
    if (symbol && isKospiStock && !seen.has(symbol)) {
      seen.add(symbol);
      symbols.push({ symbol, name: String(stock.stockName || "").trim() || symbol });
    }
  }
  return symbols.length > 0 ? { ok: true, symbols, rawRows: stocks.length, totalCount } : { ok: false, empty: true, reason: "KOSPI universe contained no common stocks" };
}

function quotePayloadRows(payload) {
  if (Array.isArray(payload?.datas)) return payload.datas;
  if (Array.isArray(payload?.result?.datas)) return payload.result.datas;
  if (Array.isArray(payload?.result?.areas)) return payload.result.areas.flatMap((area) => Array.isArray(area.datas) ? area.datas : []);
  return [];
}

async function fetchQuotes(symbols, context) {
  const quotes = [];
  for (let offset = 0; offset < symbols.length; offset += context.config.quoteBatchSize) {
    const batch = symbols.slice(offset, offset + context.config.quoteBatchSize);
    const url = `${QUOTE_ENDPOINT}${batch.map((item) => item.symbol).join(",")}`;
    const response = await fetchJson(url, context);
    if (!response.ok) return response;
    const rows = quotePayloadRows(response.payload);
    if (rows.length === 0) return { ok: false, empty: true, reason: "Naver quote response was empty" };
    quotes.push(...rows);
  }
  return { ok: true, quotes };
}

function normalizeQuote(raw, now) {
  const symbol = normalizedSymbol(raw?.symbolCode || raw?.itemCode);
  const name = String(raw?.stockName || "").trim();
  const quoteAt = parseLocalTradedAt(raw?.localTradedAt);
  const quoteAgeSeconds = quoteAt ? (now.getTime() - quoteAt.getTime()) / 1_000 : Number.POSITIVE_INFINITY;
  const closePrice = parseNumber(raw?.closePriceRaw);
  const openPrice = parseNumber(raw?.openPriceRaw);
  const previousDelta = parseNumber(raw?.compareToPreviousClosePriceRaw);
  const priorClose = closePrice !== null && previousDelta !== null && previousDelta <= closePrice
    ? closePrice - previousDelta
    : closePrice;
  return {
    symbol,
    name: name || symbol,
    openPrice,
    closePrice,
    priorClose: priorClose !== null && priorClose > 0 ? priorClose : null,
    volume: parseNumber(raw?.accumulatedTradingVolumeRaw),
    quoteAt,
    quoteAgeSeconds,
    marketStatus: String(raw?.marketStatus || raw?.marketStatusDetailType || "UNKNOWN").toUpperCase(),
  };
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : null;
}

function percent(value, base) {
  return typeof value === "number" && typeof base === "number" && base > 0 ? round(((value / base) - 1) * 100) : null;
}

function rowForQuote(quote, phase, stage, snapshotRowsBySymbol) {
  const existing = snapshotRowsBySymbol.get(quote.symbol);
  const expectedOpen = phase === "before-open" ? quote.openPrice : (existing?.expected_open ?? null);
  const expectedReturn = phase === "before-open" ? percent(expectedOpen, quote.priorClose) : (existing?.expected_return ?? null);
  const actualOpen = phase === "before-open" ? null : quote.openPrice;
  const actualClose = stage === "close-settlement" || phase === "after-close" ? quote.closePrice : null;
  const actualReturn = percent(actualOpen, quote.priorClose);
  const sessionReturn = percent(actualClose, actualOpen);
  return {
    rank: null,
    symbol: quote.symbol,
    name: quote.name,
    expected_open: expectedOpen,
    expected_close: existing?.expected_close ?? null,
    expected_return: expectedReturn,
    actual_open: actualOpen,
    actual_close: actualClose,
    actual_return: actualReturn,
    session_return: sessionReturn,
    actual_volume: quote.volume,
    prior_close: quote.priorClose,
    error: actualReturn !== null && expectedReturn !== null ? round(actualReturn - expectedReturn) : null,
    confidence: null,
    quality: phase === "before-open" ? "naver_preopen_quote" : "naver_live_quote",
    status: "valid",
    quote_at: quote.quoteAt?.toISOString() || null,
    quote_age_seconds: Number.isFinite(quote.quoteAgeSeconds) ? round(quote.quoteAgeSeconds) : null,
    market_status: quote.marketStatus,
  };
}

function rankRows(rows, phase) {
  const key = phase === "before-open" ? "expected_return" : phase === "after-close" ? "session_return" : "actual_return";
  rows.sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

function sourceMetadata(context, { status, sourceDate, rawRows, sourceRows, partial = false, quotes = [] }) {
  const ages = quotes.map((quote) => quote.quoteAgeSeconds).filter(Number.isFinite);
  const retrievedAt = (context.fetchTime || context.now()).toISOString();
  return createSourceMetadata({
    name: SOURCE_NAME,
    url: QUOTE_ENDPOINT,
    licenseStatus: "unconfirmed",
    licenseUrl: null,
    retrievedAt,
    sourceId: SOURCE_ID,
    runId: context.runId,
    status,
    fetchedAt: retrievedAt,
    sourceDate: sourceDate || null,
    rawRows,
    sourceRows,
    partial,
    metrics: {
      requested: context.metrics.requested,
      completed: context.metrics.completed,
      failed: context.metrics.failed,
      retries: context.metrics.retries,
      deadline_hit: context.metrics.deadline_hit,
      elapsed_ms: Date.now() - context.startedAt,
      estimated_ms: context.config.overallDeadlineMs,
      overall_deadline_ms: context.config.overallDeadlineMs,
      max_concurrency: 1,
      max_age_seconds: context.config.maxAgeSeconds,
      close_max_age_seconds: context.config.closeMaxAgeSeconds,
      quote_count: quotes.length,
      min_quote_age_seconds: ages.length ? round(Math.min(...ages)) : null,
      max_quote_age_seconds: ages.length ? round(Math.max(...ages)) : null,
      universe_endpoint: UNIVERSE_ENDPOINT,
      quote_endpoint_template: `${QUOTE_ENDPOINT}{codes}`,
      delayed_data_possible: true,
      license_note: "Naver public polling endpoint is unofficial; usage and redistribution terms are unconfirmed.",
    },
  });
}

function result(status, message, source = null, rows = [], asOfDate = null) {
  return { status, message, rows, source, asOfDate };
}

export function createNaverCrawlProvider({ env = globalThis.process?.env || {}, fetchImpl = globalThis.fetch, now = () => new Date(), runStartedAt = null } = {}) {
  const config = readConfig(env);
  const provider = {
    id: "naver-crawl",
    label: "NAVER PUBLIC CRAWL · UNOFFICIAL / DELAY POSSIBLE",
    status: "configured",
    getSourceMetadata() {
      return createSourceMetadata({
        name: SOURCE_NAME,
        url: QUOTE_ENDPOINT,
        licenseStatus: "unconfirmed",
        licenseUrl: null,
      });
    },
    async fetchPreviousDay() { return collect(provider, "update-results", "before-open"); },
    async runAnalysis() { return collect(provider, "analysis", "before-open"); },
    async generateForecast() { return collect(provider, "forecast", "before-open"); },
    async settleOpen() { return collect(provider, "open-settlement", "during-market"); },
    async settleClose() { return collect(provider, "close-settlement", "after-close"); },
  };

  async function collect(currentProvider, stage, requiredPhase) {
    const startedAt = Date.now();
    const context = {
      config,
      fetchImpl,
      now,
      runId: runId(env),
      startedAt,
      deadlineAt: startedAt + config.overallDeadlineMs,
      lastRequestAt: null,
      metrics: { requested: 0, completed: 0, failed: 0, retries: 0, deadline_hit: false },
    };
    const fetchTime = now();
    const referenceTime = runStartedAt ? new Date(runStartedAt) : fetchTime;
    const current = Number.isNaN(referenceTime.getTime()) ? fetchTime : referenceTime;
    context.fetchTime = fetchTime;
    context.referenceTime = current;
    const phase = resolveCrawlStage(current);
    if (requiredPhase !== phase && !(stage === "forecast" && phase === "before-open")) {
      const source = sourceMetadata(context, { status: "stage_mismatch", sourceDate: kstDate(current), rawRows: 0, sourceRows: 0 });
      return result("no_data", `${stage} stage requires ${requiredPhase}; current KST market phase is ${phase}.`, source, [], kstDate(current));
    }
    const universe = await fetchUniverse(context);
    if (!universe.ok) {
      const status = universe.blocked ? "blocked" : universe.empty ? "no_data" : "degraded";
      const source = sourceMetadata(context, { status, sourceDate: kstDate(current), rawRows: 0, sourceRows: 0, partial: status !== "no_data" });
      return result(status, `Naver KOSPI universe crawl failed: ${universe.reason}.`, source, [], kstDate(current));
    }
    const fetched = await fetchQuotes(universe.symbols, context);
    if (!fetched.ok) {
      const status = fetched.blocked ? "blocked" : fetched.empty ? "no_data" : "degraded";
      const source = sourceMetadata(context, { status, sourceDate: kstDate(current), rawRows: universe.rawRows, sourceRows: 0, partial: status !== "no_data" });
      return result(status, `Naver quote crawl failed: ${fetched.reason}.`, source, [], kstDate(current));
    }
    const quotes = fetched.quotes.map((quote) => normalizeQuote(quote, fetchTime)).filter((quote) => quote.symbol);
    const maxAgeSeconds = phase === "after-close" ? config.closeMaxAgeSeconds : config.maxAgeSeconds;
    const freshQuotes = quotes.filter((quote) => quote.quoteAt && quote.quoteAgeSeconds >= 0 && quote.quoteAgeSeconds <= maxAgeSeconds && kstDate(quote.quoteAt) === kstDate(current));
    const sourceDate = freshQuotes[0]?.quoteAt ? kstDate(freshQuotes[0].quoteAt) : kstDate(current);
    const source = sourceMetadata(context, { status: "collected", sourceDate, rawRows: universe.rawRows + fetched.quotes.length, sourceRows: freshQuotes.length, partial: freshQuotes.length !== quotes.length, quotes: freshQuotes });
    if (freshQuotes.length === 0) {
      return result("degraded", `Naver quote timestamps are missing, stale, or not from ${kstDate(current)}; no previous snapshot is reused.`, { ...source, status: "stale" }, [], sourceDate);
    }
    const currentOpenQuotes = freshQuotes.filter((quote) => quote.openPrice !== null);
    if (phase === "before-open" && currentOpenQuotes.length === 0) {
      return result("no_data", "Before-open Naver response did not contain current open/pre-open quotes; previous close is not used to synthesize expected_open.", { ...source, status: "no_preopen_quote" }, [], sourceDate);
    }
    if (phase !== "before-open" && currentOpenQuotes.length === 0) {
      return result("no_data", "Naver response did not contain openPriceRaw for the current market session; actual_open remains no_data.", { ...source, status: "no_open_quote" }, [], sourceDate);
    }
    const snapshotRowsBySymbol = new Map((currentProvider._snapshot?.rows || []).filter((row) => row.symbol).map((row) => [row.symbol, row]));
    const rows = rankRows(freshQuotes.map((quote) => rowForQuote(quote, phase, stage, snapshotRowsBySymbol)), phase);
    const readyMessage = phase === "before-open"
      ? `Collected ${rows.length} fresh Naver pre-open quotes; expected_open is derived only from openPriceRaw.`
      : phase === "after-close"
        ? `Collected ${rows.length} fresh-enough Naver post-close quotes; actual_open/actual_close are observed fields.`
        : `Collected ${rows.length} fresh Naver intraday quotes; actual_open is openPriceRaw.`;
    return result("ready", readyMessage, { ...source, status: "ready", sourceRows: rows.length }, rows, sourceDate);
  }

  const wrap = (method) => async ({ snapshot } = {}) => {
    provider._snapshot = snapshot;
    try { return await method(); } finally { provider._snapshot = null; }
  };
  provider.fetchPreviousDay = wrap(() => collect(provider, "update-results", "before-open"));
  provider.runAnalysis = wrap(() => collect(provider, "analysis", "before-open"));
  provider.generateForecast = wrap(() => collect(provider, "forecast", "before-open"));
  provider.settleOpen = wrap(() => collect(provider, "open-settlement", "during-market"));
  provider.settleClose = wrap(() => collect(provider, "close-settlement", "after-close"));
  return provider;
}
