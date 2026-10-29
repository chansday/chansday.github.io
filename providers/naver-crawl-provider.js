import {
  createSourceMetadata,
} from "./provider-adapter.js";
import { createPublicCsvProvider, fetchForecastHistory } from "./public-csv-provider.js";
import { loadNaverDailyHistory } from "./naver-daily-cache.js";
import { isKoreanSymbol } from "./korean-symbol.js";
import { checkRobotsUrl } from "./robots-policy.js";
import { KOSPI_UNIVERSE_PATH, loadKospiUniverseCache, DEFAULT_UNIVERSE_MAX_AGE_DAYS } from "./kospi-universe-cache.js";
import { NO_TRADE_STATUS, compareByExpectedReturn, deriveEvaluationError, deriveExpectedReturn, deriveSessionReturn } from "./evaluation-contract.js";
import { preopenQuoteBasis, priorHistoryEstimate } from "./forecast-basis.js";

// Every request host below is checked against its robots.txt before each data
// request. m.stock.naver.com, finance.naver.com and fchart.stock.naver.com
// disallow all paths for this agent and are not requested.
export const QUOTE_ENDPOINT = "https://polling.finance.naver.com/api/realtime/domestic/stock/";
export const UNIVERSE_ENDPOINT = "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue";
export const DAILY_HISTORY_SOURCE = "https://api.stock.naver.com/chart/domestic/item/";
const KOSPI_EXCHANGE_CODE = "KS";
const SOURCE_NAME = "네이버 금융 공개 polling 웹 크롤링 (비공식·지연 가능)";
const SOURCE_ID = "naver-public-polling-crawl";
export const USER_AGENT = "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_OVERALL_DEADLINE_MS = 120_000;
const HISTORY_GAP_TOLERANCE = 0.02;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_AGE_SECONDS = 180;
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 5;
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
    maxClockSkewSeconds: numberEnv(env, "KOSPI_CRAWL_MAX_CLOCK_SKEW_SECONDS", DEFAULT_MAX_CLOCK_SKEW_SECONDS, 0, 60),
    closeMaxAgeSeconds: numberEnv(env, "KOSPI_CRAWL_CLOSE_MAX_AGE_SECONDS", DEFAULT_CLOSE_MAX_AGE_SECONDS, 1, 172_800),
    universePageSize: numberEnv(env, "KOSPI_CRAWL_UNIVERSE_PAGE_SIZE", DEFAULT_UNIVERSE_PAGE_SIZE, 1, 100),
    quoteBatchSize: numberEnv(env, "KOSPI_CRAWL_QUOTE_BATCH_SIZE", DEFAULT_QUOTE_BATCH_SIZE, 1, 100),
    requestIntervalMs: numberEnv(env, "KOSPI_CRAWL_REQUEST_INTERVAL_MS", DEFAULT_REQUEST_INTERVAL_MS, 0, 10_000),
    universeCachePath: typeof env.KOSPI_UNIVERSE_CACHE === "string" && env.KOSPI_UNIVERSE_CACHE.trim() ? env.KOSPI_UNIVERSE_CACHE.trim() : KOSPI_UNIVERSE_PATH,
    universeMaxAgeDays: numberEnv(env, "KOSPI_UNIVERSE_MAX_AGE_DAYS", DEFAULT_UNIVERSE_MAX_AGE_DAYS, 1, 365),
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
  if (typeof value !== "string") return null;
  const raw = value.replace(/^KOSPI:/i, "");
  return isKoreanSymbol(raw) ? raw : null;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) || response.headers?.[name] || "";
}

// HTML is always a challenge. A body that parses as JSON is data, so its
// contents (e.g. a stock named "Doosan Robotics") are never keyword-matched;
// only non-JSON bodies are checked for challenge wording.
export function isChallenge(text, contentType = "") {
  if (contentType.includes("text/html")) return true;
  const body = String(text || "");
  try { JSON.parse(body); return false; } catch { /* not JSON: inspect wording */ }
  return /captcha|challenge|access denied|forbidden|too many requests|robot/i.test(body);
}

function retryNotBefore(retryAfter) {
  const value = String(retryAfter || "").trim();
  if (!value) return null;
  const at = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

async function readResponseBody(response) {
  if (typeof response.text === "function") return response.text();
  if (typeof response.json === "function") return JSON.stringify(await response.json());
  return "";
}

async function robotsGate(url, context) {
  const policy = await checkRobotsUrl(context, url, USER_AGENT, { allowMissing: true });
  context.robotsChecks ||= {};
  const origin = new URL(url).origin;
  if (!context.robotsChecks[origin]) context.robotsChecks[origin] = { robots_url: policy.robotsUrl, robots_status: policy.ok ? (policy.missing ? policy.robotsStatus : 200) : null, checked_at: policy.checkedAt || null, allowed: policy.ok };
  if (!policy.ok) { context.robotsChecks[origin].allowed = false; context.robotsChecks[origin].reason = policy.reason; }
  return policy;
}

async function fetchJson(url, context) {
  const policy = await robotsGate(url, context);
  if (!policy.ok) {
    context.metrics.failed += 1;
    return { ok: false, status: null, blocked: true, robots: true, reason: policy.reason };
  }
  for (let attempt = 0; attempt <= context.config.maxRetries; attempt += 1) {
    const remaining = context.deadlineAt - Date.now();
    if (remaining <= 0) {
      context.metrics.deadline_hit = true;
      return { ok: false, status: null, reason: "overall deadline exceeded" };
    }
    await sleep(context.lastRequestAt === null ? 0 : Math.max(0, context.config.requestIntervalMs - (Date.now() - context.lastRequestAt)));
    if (Date.now() >= context.deadlineAt) return { ok: false, status: null, reason: "overall deadline exceeded" };
    context.lastRequestAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(context.config.timeoutMs, context.deadlineAt - Date.now()));
    context.metrics.requested += 1;
    try {
      const response = await context.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        redirect: "error",
        signal: controller.signal,
      });
      const contentType = responseHeader(response, "content-type").toLowerCase();
      const body = await readResponseBody(response);
      const retryAfter = responseHeader(response, "retry-after");
      // 429 or any parseable Retry-After stops immediately: no wait, no retry.
      const notBefore = retryNotBefore(retryAfter);
      if (response.status === 429 || notBefore) {
        context.metrics.failed += 1;
        return { ok: false, status: response.status, blocked: true, retryNotBefore: notBefore, reason: `rate limit or Retry-After; collection stopped${notBefore ? ` (retry not before ${notBefore})` : ""}` };
      }
      if (response.status === 403 || isChallenge(body, contentType)) {
        context.metrics.failed += 1;
        return { ok: false, status: response.status, blocked: true, reason: response.status === 403 ? "HTTP 403 forbidden" : "Naver challenge/HTML response" };
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
      const retryable = response.status >= 500;
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

const universePageUrl = (page, pageSize) => `${UNIVERSE_ENDPOINT}?page=${page}&pageSize=${pageSize}`;
const stockSymbol = (stock) => normalizedSymbol(stock.itemCode || stock.symbolCode || stock.reutersCode);

async function fetchLiveUniverse(context) {
  const first = await fetchJson(universePageUrl(1, context.config.universePageSize), context);
  if (!first.ok) return first;
  const parseCount = value => typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  const totalCount = parseCount(first.payload?.totalCount);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0 || !Array.isArray(first.payload?.stocks)) return { ok: false, reason: "KOSPI universe totalCount or stocks is malformed" };
  if (totalCount === 0 && first.payload.stocks.length === 0) return { ok: false, empty: true, reason: `KOSPI universe is empty (marketStatus=${String(first.payload?.marketStatus || "unknown").slice(0, 32)})` };
  const pageCount = Math.ceil(totalCount / context.config.universePageSize);
  const stocks = [], rawSymbols = new Set();
  for (let page = 1; page <= Math.max(1, pageCount); page += 1) {
    const response = page === 1 ? first : await fetchJson(universePageUrl(page, context.config.universePageSize), context);
    if (!response.ok) return response;
    const payload = response.payload, rows = payload?.stocks;
    if (page > 1 && payload?.totalCount !== undefined && parseCount(payload.totalCount) !== totalCount) return { ok: false, reason: `KOSPI universe totalCount changed or malformed on page ${page}` };
    const expectedRows = Math.max(0, Math.min(context.config.universePageSize, totalCount - (page - 1) * context.config.universePageSize));
    if (!Array.isArray(rows) || rows.length !== expectedRows) return { ok: false, reason: `KOSPI universe page ${page} incomplete: expected ${expectedRows} raw rows, received ${Array.isArray(rows) ? rows.length : "invalid"}` };
    for (const stock of rows) {
      if (!stock || typeof stock !== "object" || Array.isArray(stock)) return { ok: false, reason: `KOSPI universe page ${page} contains malformed row` };
      if ((stock.stockName != null && typeof stock.stockName !== "string") || (stock.stockEndType != null && typeof stock.stockEndType !== "string") || (stock.sosok != null && !["string", "number"].includes(typeof stock.sosok))) return { ok: false, reason: `KOSPI universe page ${page} contains malformed fields` };
      const symbol = stockSymbol(stock);
      if (!symbol) return { ok: false, reason: `KOSPI universe page ${page} contains invalid symbol` };
      if (rawSymbols.has(symbol)) return { ok: false, reason: `KOSPI universe duplicate symbol on page ${page}` };
      rawSymbols.add(symbol); stocks.push(stock);
    }
  }
  if (stocks.length !== totalCount) return { ok: false, reason: "KOSPI universe totalCount mismatch" };
  const symbols = [];
  const seen = new Set();
  for (const stock of stocks) {
    const symbol = stockSymbol(stock);
    const exchange = stock.stockExchangeType?.code;
    const isKospiStock = String(stock.sosok ?? "0") === "0" && (exchange == null || exchange === KOSPI_EXCHANGE_CODE) && String(stock.stockEndType || "stock").toLowerCase() === "stock";
    if (symbol && isKospiStock && !seen.has(symbol)) {
      seen.add(symbol);
      symbols.push({ symbol, name: String(stock.stockName || "").trim() || symbol });
    }
  }
  return symbols.length > 0
    ? { ok: true, symbols, rawRows: stocks.length, totalCount, universeSource: "live", universeEndpoint: UNIVERSE_ENDPOINT, universeAsOf: (context.now ? context.now() : new Date()).toISOString(), universeStale: false }
    : { ok: false, empty: true, reason: "KOSPI universe contained no stocks in the provider category" };
}

// Live list first. Only an empty live list or a robots denial of the list host
// falls back to the committed list; 403/429/challenge and malformed pages stop.
async function fetchUniverse(context) {
  const live = await fetchLiveUniverse(context);
  if (live.ok) return live;
  if (!(live.empty || live.robots)) return live;
  const cache = await loadKospiUniverseCache({ path: context.config.universeCachePath, now: context.now, maxAgeDays: context.config.universeMaxAgeDays });
  if (!cache.ok) return { ...live, reason: `${live.reason}; ${cache.reason}` };
  return {
    ok: true,
    symbols: cache.symbols,
    rawRows: 0,
    totalCount: cache.symbols.length,
    universeSource: "cache",
    universeEndpoint: cache.path,
    universeAsOf: cache.candidatesAsOf,
    universeVerifiedAt: cache.verifiedAt,
    universeAgeDays: cache.ageDays,
    universeStale: cache.stale,
    universeCacheMethod: cache.sourceMethod,
    universeFallbackReason: live.reason,
  };
}

function newCrawlContext({ config, fetchImpl, now, deadline = Infinity, maxDurationMs = 60000 }) {
  const startedAt = Date.now();
  return { config, fetchImpl, now, startedAt, deadlineAt: Math.min(deadline, startedAt + maxDurationMs), lastRequestAt: null, metrics: { requested: 0, completed: 0, failed: 0, retries: 0, deadline_hit: false } };
}

export async function collectNaverUniverse({ fetchImpl = globalThis.fetch, now = () => new Date(), deadline = Infinity, env = {} } = {}) {
  const config = { ...readConfig(env), requestIntervalMs: 500, maxRetries: 0 };
  const context = newCrawlContext({ config, fetchImpl, now, deadline });
  const universe = await fetchUniverse(context);
  return { ...universe, robotsChecks: context.robotsChecks || {}, metrics: context.metrics };
}

// Live list only (no cache fallback); used by the universe refresh script.
export async function fetchLiveKospiUniverse({ fetchImpl = globalThis.fetch, now = () => new Date(), env = {} } = {}) {
  const config = { ...readConfig(env), requestIntervalMs: 500, maxRetries: 0 };
  const context = newCrawlContext({ config, fetchImpl, now });
  const universe = await fetchLiveUniverse(context);
  return { ...universe, robotsChecks: context.robotsChecks || {}, metrics: context.metrics };
}

// Confirms candidate symbols on the robots-permitted quote host. Only rows whose
// stockExchangeType.code is KS are kept; missing or other-exchange codes are
// reported, never guessed.
export async function verifyKospiSymbols(symbols, { fetchImpl = globalThis.fetch, now = () => new Date(), env = {}, maxDurationMs = 120000 } = {}) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.some(s => !isKoreanSymbol(s)) || new Set(symbols).size !== symbols.length) throw new Error("Invalid candidate symbols");
  const config = { ...readConfig(env), requestIntervalMs: 500, maxRetries: 0 };
  const context = newCrawlContext({ config, fetchImpl, now, maxDurationMs });
  const verified = [], other = [], missing = [];
  for (let offset = 0; offset < symbols.length; offset += config.quoteBatchSize) {
    const batch = symbols.slice(offset, offset + config.quoteBatchSize);
    const response = await fetchJson(`${QUOTE_ENDPOINT}${batch.join(",")}`, context);
    if (!response.ok) return { ok: false, blocked: Boolean(response.blocked), robots: Boolean(response.robots), reason: response.reason, verified, other, missing, robotsChecks: context.robotsChecks || {}, metrics: context.metrics };
    const rows = new Map();
    for (const row of quotePayloadRows(response.payload)) {
      const symbol = normalizedSymbol(row?.symbolCode || row?.itemCode);
      if (symbol && batch.includes(symbol) && !rows.has(symbol)) rows.set(symbol, row);
    }
    for (const symbol of batch) {
      const row = rows.get(symbol);
      if (!row) missing.push(symbol);
      else if (row.stockExchangeType?.code === KOSPI_EXCHANGE_CODE) verified.push({ symbol, name: String(row.stockName || "").trim() || symbol });
      else other.push({ symbol, exchange: String(row.stockExchangeType?.code ?? "unknown").slice(0, 16) });
    }
  }
  return { ok: true, verified, other, missing, robotsChecks: context.robotsChecks || {}, metrics: context.metrics };
}

function quotePayloadRows(payload) {
  if (Array.isArray(payload?.datas)) return payload.datas;
  if (Array.isArray(payload?.result?.datas)) return payload.result.datas;
  if (Array.isArray(payload?.result?.areas)) return payload.result.areas.flatMap((area) => Array.isArray(area.datas) ? area.datas : []);
  return [];
}

// With a live universe every requested symbol must appear exactly once. With
// the committed list, a symbol the quote host no longer returns (for example a
// delisting since the list was collected) is excluded and counted, not filled.
async function fetchQuotes(symbols, context, { tolerateMissing = false } = {}) {
  const quotes = [], missingSymbols = [];
  for (let offset = 0; offset < symbols.length; offset += context.config.quoteBatchSize) {
    const batch = symbols.slice(offset, offset + context.config.quoteBatchSize);
    const url = `${QUOTE_ENDPOINT}${batch.map((item) => item.symbol).join(",")}`;
    const response = await fetchJson(url, context);
    if (!response.ok) return response;
    const rows = quotePayloadRows(response.payload);
    if (rows.length === 0) return { ok: false, empty: true, reason: "Naver quote response was empty" };
    const expected = new Set(batch.map(item => item.symbol));
    const counts = new Map(); let unknown = 0;
    for (const row of rows) {
      const symbol = normalizedSymbol(row?.symbolCode || row?.itemCode);
      if (!symbol || !expected.has(symbol)) { unknown += 1; continue; }
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
    }
    const missingInBatch = [...expected].filter(symbol => !counts.has(symbol));
    const missing = missingInBatch.length;
    const duplicate = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    if ((missing && !tolerateMissing) || duplicate || unknown || missing === expected.size) return { ok: false, reason: `quote identity mismatch: missing=${missing}, duplicate=${duplicate}, unknown=${unknown}` };
    missingSymbols.push(...missingInBatch);
    quotes.push(...rows);
  }
  return { ok: true, quotes, missingSymbols };
}

// Read-only helper for dry runs: same robots gate, throttle and identity checks.
export async function fetchNaverQuotes(symbols, { fetchImpl = globalThis.fetch, now = () => new Date(), env = {} } = {}) {
  const config = { ...readConfig(env), requestIntervalMs: Math.max(500, readConfig(env).requestIntervalMs), maxRetries: 0 };
  const context = newCrawlContext({ config, fetchImpl, now });
  const fetched = await fetchQuotes(symbols.map(symbol => ({ symbol })), context);
  const quotes = fetched.ok ? fetched.quotes.map(quote => normalizeQuote(quote, now())) : [];
  return { ...fetched, quotes, robotsChecks: context.robotsChecks || {}, metrics: context.metrics };
}

// The polling quote's change field is signed (e.g. "-15" when falling) and is
// measured against the regular-market reference price, so the previous close is
// close - change. The direction code must agree with the sign; otherwise, or
// when a field is missing, prior_close stays null (never the current price).
const DIRECTION_SIGN = { 1: 1, 2: 1, 3: 0, 4: -1, 5: -1 };
export const PRIOR_CLOSE_SOURCE = "naver_polling_close_minus_change";
export function quotePriorClose(raw, closePrice = parseNumber(raw?.closePriceRaw)) {
  const text = String(raw?.compareToPreviousClosePriceRaw ?? "").replaceAll(",", "").trim();
  if (closePrice === null || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const change = Number(text);
  const code = raw?.compareToPreviousPrice?.code;
  if (code !== undefined && code !== null) {
    const sign = DIRECTION_SIGN[String(code)];
    if (sign === undefined || Math.sign(change) !== sign) return null;
  }
  const prior = closePrice - change;
  return Number.isFinite(prior) && prior > 0 ? prior : null;
}

function normalizeQuote(raw, now) {
  const symbol = normalizedSymbol(raw?.symbolCode || raw?.itemCode);
  const name = String(raw?.stockName || "").trim();
  const quoteAt = parseLocalTradedAt(raw?.localTradedAt);
  const quoteAgeSeconds = quoteAt ? (now.getTime() - quoteAt.getTime()) / 1_000 : Number.POSITIVE_INFINITY;
  const closePrice = parseNumber(raw?.closePriceRaw);
  const openPrice = parseNumber(raw?.openPriceRaw);
  const priorClose = quotePriorClose(raw, closePrice);
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
    exchange: typeof raw?.stockExchangeType?.code === "string" ? raw.stockExchangeType.code : null,
    // Trading-halt markers as sent by the polling endpoint (observed
    // 2026-10-29: tradeStopType.name "HALTED", tradableStatus "halt").
    tradeStopType: typeof raw?.tradeStopType?.name === "string" ? raw.tradeStopType.name.trim().toUpperCase() : null,
    tradableStatus: typeof raw?.tradableStatus === "string" ? raw.tradableStatus.trim().toLowerCase() : null,
    tradableStatusCode: typeof raw?.tradableStatusCode === "string" ? raw.tradableStatusCode.trim() : null,
  };
}

// The source itself marks the symbol as halted. Missing prices alone are never
// a halt (a halted quote sends empty open/volume, so zeros are not required).
export function isHaltedQuote(quote) {
  return quote?.tradeStopType === "HALTED" || quote?.tradableStatus === "halt";
}

export function haltEvidence(quote) {
  return { source: "naver_polling_quote", trade_stop_type: quote.tradeStopType, tradable_status: quote.tradableStatus, tradable_status_code: quote.tradableStatusCode, observed_at: quote.quoteAt.toISOString(), reason: "Naver polling quote marks the symbol as halted (tradeStopType/tradableStatus)" };
}

export function markNoTrade(row, evidence) {
  Object.assign(row, { actual_open: null, actual_close: null, actual_volume: null, session_return: null, error: null, trading_status: NO_TRADE_STATUS, no_trade_evidence: evidence });
  return row;
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : null;
}

function percent(value, base) {
  return typeof value === "number" && typeof base === "number" && base > 0 ? round(((value / base) - 1) * 100) : null;
}

// History is newest first; only prior-day observations enter this opening estimate.
export function historicalOpenEstimate(sessions, symbol) {
  return priorHistoryEstimate(sessions, symbol)?.expected_open ?? null;
}

// Records after run start are usable only from this run, and never from
// after the current stage's actual collection start.
export function savedOpeningIsTimely(recordedAt, runStartedAt, stageStartedAt, sameRun) {
  const recorded = Date.parse(recordedAt), started = Date.parse(runStartedAt), stage = Date.parse(stageStartedAt);
  return Number.isFinite(recorded) && Number.isFinite(started) && Number.isFinite(stage)
    && recorded <= stage && (recorded <= started || sameRun === true);
}

function rowForQuote(quote, phase, stage, snapshotRowsBySymbol, history, runStartedAt, stageStartedAt, sameRun) {
  const isForecastStage = ["update-results", "analysis", "forecast"].includes(stage);
  const manualRunAll = quote.manualRunAll === true;
  const existing = snapshotRowsBySymbol.get(quote.symbol);
  const intradayExpectedStart = manualRunAll && isForecastStage && phase !== "before-open" ? quote.closePrice : null;
  const src = existing?.expected_open_source;
  const sourceDate = src?.recorded_at ? new Date(src.recorded_at) : null;
  const validDates = Array.isArray(src?.history_dates) && (src.kind === "preopen_quote" ? src.history_dates.length === 0 : src.history_dates.length === 3 && src.history_dates.every((date, i) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < kstDate(quote.quoteAt) && (i === 0 || date < src.history_dates[i - 1])));
  const sourcePhase = sourceDate && Number.isFinite(sourceDate.getTime()) ? resolveCrawlStage(sourceDate) : null;
  const recorded = existing?.expected_open > 0 && validDates && sourceDate && savedOpeningIsTimely(src.recorded_at, runStartedAt, stageStartedAt, sameRun) && kstDate(sourceDate) === kstDate(quote.quoteAt) && (["preopen_quote", "preopen_history"].includes(src.kind) ? sourcePhase === "before-open" : src.kind === "retrospective_history" && sourcePhase !== "before-open") ? existing : null;
  const preopen = phase === "before-open" && quote.marketStatus === "PREOPEN" && quote.quoteAt && resolveCrawlStage(quote.quoteAt) === "before-open" && quote.openPrice > 0;
  const historyEstimate = history?.ok ? priorHistoryEstimate(history.sessions, quote.symbol, { returnHistory: history.return_history?.[quote.symbol] ?? null, forecastModel: history.forecast_model ?? null, rankForecast: history.rank_forecast ?? null }) : null;
  const estimate = historyEstimate?.expected_open ?? null;
  const expectedOpen = recorded?.expected_open ?? (preopen ? quote.openPrice : estimate);
  const openSource = recorded?.expected_open_source ?? (preopen
    ? { kind: "preopen_quote", recorded_at: quote.quoteAt.toISOString(), history_dates: [] }
    // recorded_at is when this stage recorded the estimate (not when the cache
    // was collected, which may be the previous evening).
    : estimate !== null ? { kind: phase === "before-open" ? "preopen_history" : "retrospective_history", recorded_at: new Date(stageStartedAt).toISOString(), history_dates: history.sessions.map((s) => s.date) } : null);
  // The basis travels with the value it explains. A recorded opening keeps its
  // own basis and closing estimate; a new history opening brings the closing
  // estimate of the same prior-history model; a pre-open quote has no closing model.
  const openBasis = recorded ? recorded.expected_open_basis ?? null
    : preopen ? preopenQuoteBasis({ openPrice: quote.openPrice, quoteAt: quote.quoteAt.toISOString(), marketStatus: "PREOPEN" })
      : estimate !== null ? historyEstimate.open_basis : null;
  const fromHistory = !recorded && !preopen && estimate !== null;
  const expectedClose = recorded ? recorded.expected_close ?? null : preopen ? null : fromHistory ? historyEstimate.expected_close : existing?.expected_close ?? null;
  const closeBasis = recorded ? recorded.expected_close_basis ?? null : fromHistory ? historyEstimate.close_basis : null;
  const expectedReturn = deriveExpectedReturn({ expected_open: expectedOpen, expected_close: expectedClose });
  const actualOpen = ["open-settlement", "close-settlement"].includes(stage) ? quote.openPrice : null;
  const actualClose = stage === "close-settlement" ? quote.closePrice : null;
  const sessionReturn = deriveSessionReturn({ actual_open: actualOpen, actual_close: actualClose });
  const intradayReferenceReturn = intradayExpectedStart !== null ? percent(intradayExpectedStart, quote.priorClose) : null;
  return {
    rank: null,
    symbol: quote.symbol,
    name: quote.name,
    expected_open: expectedOpen,
    ...(openSource ? { expected_open_source: openSource } : {}),
    ...(openSource && openBasis ? { expected_open_basis: openBasis } : {}),
    expected_close: expectedClose,
    ...(expectedClose !== null && closeBasis ? { expected_close_basis: closeBasis } : {}),
    expected_return: expectedReturn,
    actual_open: actualOpen,
    actual_close: actualClose,
    actual_return: null,
    session_return: sessionReturn,
    ...(intradayReferenceReturn !== null ? { intraday_reference_return: intradayReferenceReturn } : {}),
    actual_volume: quote.volume,
    prior_close: quote.priorClose,
    ...(quote.priorClose !== null ? { prior_close_source: PRIOR_CLOSE_SOURCE } : {}),
    error: deriveEvaluationError({ expected_open: expectedOpen, expected_close: expectedClose, actual_open: actualOpen, actual_close: actualClose }),
    confidence: null,
    quality: phase === "before-open"
      ? "naver_preopen_quote"
      : intradayExpectedStart !== null
        ? "naver_intraday_quote_baseline"
        : "naver_live_quote",
    status: "valid",
    quote_at: quote.quoteAt?.toISOString() || null,
    quote_age_seconds: Number.isFinite(quote.quoteAgeSeconds) ? round(Math.max(0, quote.quoteAgeSeconds)) : null,
    market_status: quote.marketStatus,
  };
}

function isForecastStage(stage) {
  return ["update-results", "analysis", "forecast"].includes(stage);
}

// Rank is always by expected return in every stage; rows without one follow
// in symbol order. Intraday session_return is null until close, so ranking by
// it after the open left the list in symbol order.
function rankRows(rows) {
  rows.sort(compareByExpectedReturn);
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

function sourceMetadata(context, { status, sourceDate, rawRows, sourceRows, partial = false, quotes = [] }) {
  const ages = quotes.map((quote) => Math.max(0, quote.quoteAgeSeconds)).filter(Number.isFinite);
  const retrievedAt = (context.collectionAt || context.fetchTime || context.now()).toISOString();
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
      universe_endpoint: context.universe?.universeEndpoint || UNIVERSE_ENDPOINT,
      universe_source: context.universe?.universeSource || null,
      universe_as_of: context.universe?.universeAsOf || null,
      universe_stale: context.universe ? Boolean(context.universe.universeStale) : null,
      ...(context.universe?.universeSource === "cache" ? { universe_age_days: context.universe.universeAgeDays, universe_verified_at: context.universe.universeVerifiedAt, universe_fallback_reason: context.universe.universeFallbackReason, universe_cache_method: context.universe.universeCacheMethod } : {}),
      ...(context.excluded ? { excluded_missing_quotes: context.excluded.missing, excluded_non_kospi_quotes: context.excluded.nonKospi } : {}),
      robots: context.robotsChecks || {},
      quote_endpoint_template: `${QUOTE_ENDPOINT}{codes}`,
      delayed_data_possible: true,
      source_basis: context.historyBasis,
      security_type: "unknown",
      license_note: "Naver public polling endpoint is unofficial; usage and redistribution terms are unconfirmed.",
    },
  });
}

function result(status, message, source = null, rows = [], asOfDate = null) {
  return { status, message, rows, source, asOfDate };
}

export function createNaverCrawlProvider({ env = globalThis.process?.env || {}, fetchImpl = globalThis.fetch, runContext = null, now = () => new Date(), runStartedAt = null } = {}) {
  const config = readConfig(env);
  const historicalRunDate = /^\d{4}-\d{2}-\d{2}$/.test(String(env.KOSPI_RUN_DATE || "")) ? env.KOSPI_RUN_DATE : null;
  const historicalProvider = historicalRunDate && kstDate(now()) !== historicalRunDate
    ? createPublicCsvProvider({
      env: { ...env, KOSPI_STABLE_SNAPSHOT: "1" },
      fetchImpl,
      now,
      targetDate: historicalRunDate,
      sourceTimestamp: runStartedAt || runContext?.referenceTime || runContext?.startedAt || now().toISOString(),
    })
    : null;
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
    async fetchPreviousDay() { return historicalProvider ? historicalProvider.fetchPreviousDay() : collect(provider, "update-results", "before-open"); },
    async runAnalysis() { return historicalProvider ? historicalProvider.runAnalysis() : collect(provider, "analysis", "before-open"); },
    async generateForecast() { return historicalProvider ? historicalProvider.generateForecast() : collect(provider, "forecast", "before-open"); },
    async settleOpen() { return historicalProvider ? historicalProvider.settleOpen() : collect(provider, "open-settlement", "during-market"); },
    async settleClose() { return historicalProvider ? historicalProvider.settleClose() : collect(provider, "close-settlement", "after-close"); },
  };

  async function collect(currentProvider, stage, requiredPhase) {
    const startedAt = Date.now();
    const context = {
      config,
      fetchImpl,
      now,
      runId: runId(env),
      historyBasis: env.KOSPI_DAILY_HISTORY === "naver-cache" ? "naver-daily" : "unknown",
      startedAt,
      deadlineAt: startedAt + config.overallDeadlineMs,
      lastRequestAt: null,
      metrics: { requested: 0, completed: 0, failed: 0, retries: 0, deadline_hit: false },
    };
    const fetchTime = now();
    const referenceTime = runContext?.startedAt
      ? new Date(runContext.startedAt)
      : runStartedAt
        ? new Date(runStartedAt)
        : fetchTime;
    const current = Number.isNaN(referenceTime.getTime()) ? fetchTime : referenceTime;
    context.fetchTime = fetchTime;
    context.referenceTime = current;
    const phase = resolveCrawlStage(current);
    const manualRunAll = String(env.KOSPI_MANUAL_RUN_ALL || "") === "1";
    const stagePhase = stage === "open-settlement"
      ? "during-market"
      : stage === "close-settlement"
        ? "after-close"
        : manualRunAll
          ? phase
          : "before-open";
    const phaseAllowed = stagePhase === "before-open"
      ? phase === "before-open"
      : stagePhase === "during-market"
        ? phase !== "before-open"
        : phase === "after-close";
    if (!phaseAllowed) {
      const source = sourceMetadata(context, { status: "stage_mismatch", sourceDate: kstDate(current), rawRows: 0, sourceRows: 0 });
      const availability = stagePhase === "before-open"
        ? "current pre-open quote is not available at this run time"
        : `${stagePhase} data is not available at this run time`;
      return result("no_data", `${stage} stage is pending: ${availability}; no values are synthesized.`, source, [], kstDate(current));
    }
    const universe = await fetchUniverse(context);
    if (!universe.ok) {
      const status = universe.blocked ? "blocked" : universe.empty ? "no_data" : "degraded";
      const source = sourceMetadata(context, { status, sourceDate: kstDate(current), rawRows: 0, sourceRows: 0, partial: status !== "no_data" });
      return result(status, `Naver KOSPI universe crawl failed: ${universe.reason}.`, source, [], kstDate(current));
    }
    context.universe = universe;
    const fetched = await fetchQuotes(universe.symbols, context, { tolerateMissing: universe.universeSource === "cache" });
    if (!fetched.ok) {
      const status = fetched.blocked ? "blocked" : fetched.empty ? "no_data" : "degraded";
      const source = sourceMetadata(context, { status, sourceDate: kstDate(current), rawRows: universe.rawRows, sourceRows: 0, partial: status !== "no_data" });
      return result(status, `Naver quote crawl failed: ${fetched.reason}.`, source, [], kstDate(current));
    }
    const collectionAt = now();
    context.collectionAt = Number.isNaN(collectionAt.getTime()) ? fetchTime : collectionAt;
    const normalizedQuotes = fetched.quotes.map((quote) => normalizeQuote(quote, context.collectionAt)).filter((quote) => quote.symbol);
    // A quote that names another exchange (e.g. KQ) is excluded, not relabelled.
    const quotes = normalizedQuotes.filter((quote) => quote.exchange === null || quote.exchange === KOSPI_EXCHANGE_CODE);
    const excludedNonKospi = normalizedQuotes.length - quotes.length;
    const excludedMissing = fetched.missingSymbols?.length || 0;
    if (excludedNonKospi || excludedMissing) context.excluded = { missing: excludedMissing, nonKospi: excludedNonKospi };
    const universeWarning = universe.universeSource === "cache"
      ? ` Universe from committed list ${universe.universeEndpoint} (candidates as of ${universe.universeAsOf})${universe.universeStale ? " (stale)" : ""} because the live list was unavailable: ${universe.universeFallbackReason}.${excludedMissing ? ` ${excludedMissing} listed symbol(s) returned no quote and were excluded.` : ""}`
      : "";
    const excludedWarning = excludedNonKospi ? ` ${excludedNonKospi} quote(s) were not on the KOSPI exchange and were excluded.` : "";
    const maxAgeSeconds = phase === "after-close" ? config.closeMaxAgeSeconds : config.maxAgeSeconds;
    const freshQuotes = quotes.filter((quote) => quote.quoteAt
      && quote.quoteAgeSeconds >= -config.maxClockSkewSeconds
      && quote.quoteAgeSeconds <= maxAgeSeconds
      && kstDate(quote.quoteAt) === kstDate(current)
      && (stage !== "open-settlement" || resolveCrawlStage(quote.quoteAt) !== "before-open")
      && (stage !== "close-settlement" || resolveCrawlStage(quote.quoteAt) === "after-close"));
    const sourceDate = freshQuotes[0]?.quoteAt ? kstDate(freshQuotes[0].quoteAt) : kstDate(current);
    const partialQuotes = freshQuotes.length !== quotes.length;
    const universePartial = Boolean(universe.universeStale || excludedNonKospi || excludedMissing);
    const source = sourceMetadata(context, { status: partialQuotes ? "partial" : "collected", sourceDate, rawRows: universe.rawRows + fetched.quotes.length, sourceRows: freshQuotes.length, partial: partialQuotes, quotes });
    if (freshQuotes.length === 0) {
      return result("degraded", `Naver quote timestamps are missing, stale, or not from ${kstDate(current)}; no previous snapshot is reused.`, { ...source, status: "stale" }, [], sourceDate);
    }
    const currentOpenQuotes = freshQuotes.filter((quote) => quote.openPrice > 0);
    const currentQuoteRows = freshQuotes.filter((quote) => quote.closePrice > 0);
    if (stage === "open-settlement" && currentOpenQuotes.length === 0) {
      return result("no_data", "Naver response did not contain openPriceRaw for the current market session; actual_open remains no_data.", { ...source, status: "no_open_quote" }, [], sourceDate);
    }
    if (manualRunAll && isForecastStage(stage) && phase !== "before-open" && currentQuoteRows.length === 0) {
      return result("no_data", "Manual intraday run-all requires a fresh current quote; expected_open is not synthesized from a missing quote.", { ...source, status: "no_current_quote" }, [], sourceDate);
    }
    const snapshotRowsBySymbol = new Map((currentProvider._snapshot?.asOfDate === kstDate(current) ? currentProvider._snapshot?.rows || [] : []).filter((row) => row.symbol).map((row) => [row.symbol, row]));
    const sameRun = Boolean(env.KOSPI_RUN_ID && currentProvider._snapshot?.meta?.run_id === env.KOSPI_RUN_ID);
    const needsHistory = freshQuotes.some((quote) => !(rowForQuote(quote, phase, stage, snapshotRowsBySymbol, null, current, fetchTime, sameRun).expected_open > 0) && !(phase === "before-open" && quote.marketStatus === "PREOPEN" && quote.openPrice > 0 && quote.quoteAt && resolveCrawlStage(quote.quoteAt) === "before-open"));
    let history = null;
    let historyFailure = null;
    if (needsHistory || env.KOSPI_DAILY_HISTORY === "naver-cache") {
      history = env.KOSPI_DAILY_HISTORY === "naver-cache"
        ? await loadNaverDailyHistory({ targetDate: kstDate(current), now })
        : await fetchForecastHistory({ env, fetchImpl, now, targetDate: kstDate(current) });
      if (!history.ok) { if (needsHistory || env.KOSPI_DAILY_HISTORY === "naver-cache") historyFailure = history; history = null; }
    }
    const completedAt = now();
    if (kstDate(completedAt) !== kstDate(current) || resolveCrawlStage(completedAt) !== phase) return result("no_data", "Market phase changed during collection; no opening estimate recorded.", { ...source, status: "stage_mismatch" }, [], sourceDate);
    const priorRows = new Map((history?.sessions?.[0]?.rows || []).map(row => [row.symbol, row]));
    const rows = rankRows(freshQuotes.map((quote) => ({ ...quote, manualRunAll })).map((quote) => rowForQuote(quote, phase, stage, snapshotRowsBySymbol, history, current, fetchTime, sameRun)), stagePhase);
    // no_trade: a fresh same-day quote marked halted by the source, in every
    // stage (freshQuotes already require the stage's timestamp window); in
    // forecast stages also symbols excluded from history only by zero volume.
    const settling = stage === "open-settlement" || stage === "close-settlement";
    // A symbol halted after it traded today (volume > 0) is not "no trade": its
    // observed prices are settled normally.
    const settlementZero = new Set(freshQuotes.filter((q) => isHaltedQuote(q) && !(q.volume > 0)).map((q) => q.symbol));
    const historyNoTrade = new Map(!settling ? (history?.no_trade_symbols || []).map((entry) => [entry.symbol, entry]) : []);
    const quoteBySymbol = new Map(freshQuotes.map((q) => [q.symbol, q]));
    for (const row of rows) {
      if (settlementZero.has(row.symbol)) {
        const evidence = haltEvidence(quoteBySymbol.get(row.symbol));
        if (settling) markNoTrade(row, evidence);
        else {
          // A halted symbol gets no opening estimate in a forecast stage.
          Object.assign(row, { expected_open: null, expected_return: null, error: null, trading_status: NO_TRADE_STATUS, no_trade_evidence: evidence });
          delete row.expected_open_source; delete row.expected_open_basis;
          if (row.expected_close_basis) { row.expected_close = null; delete row.expected_close_basis; }
        }
      } else if (historyNoTrade.has(row.symbol) && !(row.expected_open > 0)) Object.assign(row, { trading_status: NO_TRADE_STATUS, no_trade_evidence: { source: "naver_daily_history", volume: 0, dates: historyNoTrade.get(row.symbol).dates, reason: "Prior daily sessions report volume 0 (likely halted); expected_open stays null" } });
    }
    const noTradeCount = rows.filter((row) => row.trading_status === NO_TRADE_STATUS).length;
    if (history?.source === "naver-daily") {
      source.metrics.history_status = history.partial ? "partial" : "ready";
      source.metrics.history_reason = `${history.excluded_count} symbols excluded; ${history.comparison_conflicts} daily comparison conflicts; Naver daily venue and adjustment unconfirmed and may differ from regular-market quotes; redistribution rights unconfirmed`;
      source.metrics.history_source = DAILY_HISTORY_SOURCE;
    }
    // Settlement records observed prices, which do not depend on prior history.
    // A history failure there is kept visible in metrics and the message but
    // does not change the settlement status; forecast stages still fail on it.
    const settlementStage = stage === "open-settlement" || stage === "close-settlement";
    let historyWarning = "";
    if (historyFailure && settlementStage) {
      const historyStatus = historyFailure.blocked ? "blocked" : "degraded";
      const historyReason = String(historyFailure.reason || "unknown history error");
      Object.assign(source.metrics, { history_status: historyStatus, history_reason: historyReason, history_source: env.KOSPI_DAILY_HISTORY === "naver-cache" ? DAILY_HISTORY_SOURCE : "https://aikstockdata.com/data/public/daily" });
      historyWarning = ` Prior daily history ${historyStatus}: ${historyReason}; expected openings without a saved pre-open record remain unavailable (settlement prices unaffected).`;
    } else if (historyFailure) {
      const historyStatus = historyFailure.blocked ? "blocked" : "degraded";
      const historyReason = String(historyFailure.reason || "unknown history error");
      const failedSource = { ...source, status: historyStatus, partial: true, source_rows: rows.length,
        metrics: { ...source.metrics, history_status: historyStatus, history_reason: historyReason, history_source: env.KOSPI_DAILY_HISTORY === "naver-cache" ? DAILY_HISTORY_SOURCE : "https://aikstockdata.com/data/public/daily" } };
      return result(historyStatus, `Prior daily history ${historyStatus}: ${historyReason}; missing opening estimates remain unavailable.`, failedSource, rows, sourceDate);
    }
    if (isForecastStage(stage) && rows.every((row) => row.expected_open === null)) return result("no_data", "No verified pre-open quote or complete prior history; expected_open remains unavailable.", { ...source, status: "no_preopen_quote" }, [], sourceDate);
    const readyMessage = `Opening estimates: pre-open quote or prior three-session history; history calculated after the open is retrospective. Missing history remains no_data.${history?.source === "naver-daily" ? ` Naver daily market and adjustment basis unconfirmed and may differ from regular-market quotes; ${history.comparison_conflicts} comparison conflicts recorded.` : ""}`;
    const missingOpenings = env.KOSPI_DAILY_HISTORY === "naver-cache" && !settlementStage ? rows.filter(row => !(row.expected_open > 0) && row.trading_status !== NO_TRADE_STATUS).length : 0;
    const missingHistory = env.KOSPI_DAILY_HISTORY === "naver-cache" && !settlementStage ? freshQuotes.filter(quote => !priorRows.has(quote.symbol) && !historyNoTrade.has(quote.symbol) && !settlementZero.has(quote.symbol)).length : 0;
    const missingObserved = stage === "open-settlement" ? freshQuotes.filter(q => !(q.openPrice > 0) && !settlementZero.has(q.symbol)).length : stage === "close-settlement" ? freshQuotes.filter(q => !(q.openPrice > 0 && q.closePrice > 0) && !settlementZero.has(q.symbol)).length : 0;
    source.metrics.no_trade_count = noTradeCount;
    // History gaps of symbols that are no_trade (zero-volume history or a
    // current halt marker) do not make the stage partial; any other gap does.
    const historyPartialRaw = Boolean(history?.partial) && (!Array.isArray(history.symbols) || !Array.isArray(history.valid_symbols) || history.symbols.some((s) => !history.valid_symbols.includes(s) && !historyNoTrade.has(s) && !settlementZero.has(s)));
    // A few thinly traded symbols (e.g. a preferred share with a zero-volume
    // prior session) lacking complete history keep their own expected_open as
    // no_data; only gaps above HISTORY_GAP_TOLERANCE of the fresh quotes make
    // the stage partial. Malformed history metadata is never tolerated.
    const historyGapSymbols = !settlementStage && env.KOSPI_DAILY_HISTORY === "naver-cache" ? [...new Set([
      ...(Array.isArray(history?.symbols) && Array.isArray(history?.valid_symbols) ? history.symbols.filter((s) => !history.valid_symbols.includes(s) && !historyNoTrade.has(s) && !settlementZero.has(s)) : []),
      ...freshQuotes.filter(quote => !priorRows.has(quote.symbol) && !historyNoTrade.has(quote.symbol) && !settlementZero.has(quote.symbol)).map((quote) => quote.symbol),
      ...rows.filter(row => !(row.expected_open > 0) && row.trading_status !== NO_TRADE_STATUS).map((row) => row.symbol),
    ])].sort() : [];
    const historyMetaValid = !history?.partial || (Array.isArray(history.symbols) && Array.isArray(history.valid_symbols));
    const historyGapTolerated = historyMetaValid && historyGapSymbols.length > 0 && historyGapSymbols.length <= Math.floor(freshQuotes.length * HISTORY_GAP_TOLERANCE);
    if (historyGapSymbols.length) source.metrics.history_gap_symbols = historyGapSymbols;
    const historyPartial = historyPartialRaw && !historyGapTolerated;
    const historyGapPartial = !historyGapTolerated && (missingOpenings || missingHistory);
    const resultStatus = universePartial || partialQuotes || (historyPartial && !settlementStage) || historyGapPartial || missingObserved ? "partial" : "ready";
    const partialMessage = `${partialQuotes ? ` ${quotes.length - freshQuotes.length} quote(s) were stale or missing timestamps.` : ""}${historyPartial ? ` ${history.excluded_count} symbols lack complete prior history.` : ""}${missingHistory ? ` ${missingHistory} current symbols have no complete history.` : ""}${missingOpenings ? ` ${missingOpenings} symbols have no expected opening.` : ""}${historyGapTolerated ? ` ${historyGapSymbols.length} symbol(s) without complete prior history keep expected_open as no_data (within the ${HISTORY_GAP_TOLERANCE * 100}% tolerance): ${historyGapSymbols.join(", ")}.` : ""}${missingObserved ? ` ${missingObserved} symbols lack required observed prices.` : ""}${noTradeCount ? ` ${noTradeCount} symbol(s) are no_trade_observed (source halt marker or zero-volume candle) and are kept without prices or error.` : ""}${historyWarning}`;
    return result(resultStatus, `${readyMessage}${partialMessage}${universeWarning}${excludedWarning} Naver daily market and adjustment basis are unconfirmed; preferred shares may be included.`, { ...source, status: resultStatus, partial: resultStatus === "partial", source_rows: rows.length }, rows, sourceDate);
  }

  const wrap = (method) => async ({ snapshot } = {}) => {
    provider._snapshot = snapshot;
    try { return await method(); } finally { provider._snapshot = null; }
  };
  provider.fetchPreviousDay = historicalProvider
    ? (...args) => historicalProvider.fetchPreviousDay(...args)
    : wrap(() => collect(provider, "update-results", "before-open"));
  provider.runAnalysis = historicalProvider
    ? (...args) => historicalProvider.runAnalysis(...args)
    : wrap(() => collect(provider, "analysis", "before-open"));
  provider.generateForecast = historicalProvider
    ? (...args) => historicalProvider.generateForecast(...args)
    : wrap(() => collect(provider, "forecast", "before-open"));
  provider.settleOpen = historicalProvider
    ? (...args) => historicalProvider.settleOpen(...args)
    : wrap(() => collect(provider, "open-settlement", "during-market"));
  provider.settleClose = historicalProvider
    ? (...args) => historicalProvider.settleClose(...args)
    : wrap(() => collect(provider, "close-settlement", "after-close"));
  return provider;
}
