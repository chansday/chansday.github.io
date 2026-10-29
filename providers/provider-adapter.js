import { NO_TRADE_STATUS, deriveEvaluationError, deriveExpectedReturn, evaluationRowStatus, isEvaluationSummary, isNoTradeRow } from "./evaluation-contract.js";
import { isKoreanSymbol } from "./korean-symbol.js";
import { OPEN_GAP_MODEL, isCloseBasis, isOpenBasis } from "./forecast-basis.js";

/**
 * Provider contract for the static KOSPI signal board.
 *
 * Adapters are deliberately transport-agnostic. A production adapter must
 * validate the provider response before returning it and must include source
 * metadata. This module contains no credentials and does not make requests.
 */
export const PROVIDER_METHODS = Object.freeze([
  "fetchPreviousDay",
  "runAnalysis",
  "generateForecast",
  "settleOpen",
  "settleClose",
]);

export const RANKING_FIELDS = Object.freeze([
  "expected_open",
  "expected_close",
  "expected_return",
  "actual_open",
  "actual_close",
  "actual_return",
  "error",
]);

export const OPTIONAL_ROW_FIELDS = Object.freeze([
  "confidence",
  "expected_open_source",
  "expected_open_basis",
  "expected_close_basis",
  "prior_close_source",
  "quality",
  "actual_volume",
  "prior_close",
  "session_return",
  "intraday_reference_return",
  "features",
  "quote_at",
  "quote_age_seconds",
  "market_status",
  "trading_status",
  "no_trade_evidence",
]);

export const NO_TRADE_SOURCES = Object.freeze(["naver_polling_quote", "naver_daily_candle", "naver_daily_history"]);

// No trade must be reported by the source itself (a polling halt marker, or a
// daily candle with volume 0), never inferred from missing values; such a row
// carries no observed prices and no error.
export function isNoTradeEvidence(row) {
  const e = row.no_trade_evidence;
  if (row.trading_status !== NO_TRADE_STATUS || !e || typeof e !== "object" || Array.isArray(e)) return false;
  if (!NO_TRADE_SOURCES.includes(e.source) || typeof e.reason !== "string" || !e.reason) return false;
  if (e.source === "naver_polling_quote" && ((e.trade_stop_type !== "HALTED" && e.tradable_status !== "halt") || typeof e.observed_at !== "string" || !Number.isFinite(Date.parse(e.observed_at)))) return false;
  if (e.source !== "naver_polling_quote" && (e.volume !== 0 || !Array.isArray(e.dates) || !e.dates.length || e.dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d)))) return false;
  if (e.source === "naver_daily_history" && row.expected_open !== null) return false;
  return row.actual_open === null && row.actual_close === null && row.error === null;
}

export const SNAPSHOT_STATUSES = Object.freeze([
  "ready",
  "demo",
  "no_data",
  "partial",
  "degraded",
  "blocked",
  "pending",
]);

export const PIPELINE_KEYS = Object.freeze([
  "previousResult",
  "analysis",
  "forecast",
  "openSettlement",
  "closeSettlement",
]);

export function isProviderAdapter(candidate) {
  return Boolean(
    candidate &&
    typeof candidate.id === "string" &&
    typeof candidate.getSourceMetadata === "function" &&
    PROVIDER_METHODS.every((method) => typeof candidate[method] === "function"),
  );
}

export function isFiniteOrNull(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export function isRankingRow(row) {
  if (!row || typeof row !== "object") return false;
  const allowedFields = new Set(["rank", "symbol", "name", "status", ...RANKING_FIELDS, ...OPTIONAL_ROW_FIELDS]);
  const requiredFields = new Set(["rank", "symbol", "name", "status", ...RANKING_FIELDS]);
  const hasAllFields = [...requiredFields].every((field) => Object.hasOwn(row, field));
  if (Object.keys(row).some((field) => !allowedFields.has(field))) return false;
  if (!hasAllFields) return false;
  if (row.rank !== null && (!Number.isInteger(row.rank) || row.rank < 1)) return false;
  if (row.symbol !== null && typeof row.symbol !== "string") return false;
  if (row.name !== null && typeof row.name !== "string") return false;
  if (typeof row.status !== "string") return false;
  if (Object.hasOwn(row, "confidence") && !isFiniteOrNull(row.confidence)) return false;
  if (Object.hasOwn(row, "expected_open_source")) {
    const src = row.expected_open_source;
    if (!src || !["preopen_quote", "preopen_history", "retrospective_history"].includes(src.kind) || (typeof src.recorded_at !== "string" || !Number.isFinite(Date.parse(src.recorded_at))) || !Array.isArray(src.history_dates) || !(row.expected_open > 0)) return false;
    if (Object.keys(src).sort().join(",") !== "history_dates,kind,recorded_at" || (src.kind === "preopen_quote" ? src.history_dates.length !== 0 : src.history_dates.length !== 3 || src.history_dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d)))) return false;
  }
  // Basis fields must reproduce the stored value from their own inputs.
  if (Object.hasOwn(row, "expected_open_basis") && !isOpenBasis(row.expected_open_basis, row)) return false;
  if (Object.hasOwn(row, "expected_close_basis") && (!isCloseBasis(row.expected_close_basis, row) || row.expected_open_basis?.model !== OPEN_GAP_MODEL || row.expected_close_basis.history_dates.join() !== row.expected_open_basis.history_dates.join())) return false;
  if (Object.hasOwn(row, "prior_close_source") && (row.prior_close_source !== "naver_polling_close_minus_change" || !(row.prior_close > 0))) return false;
  if (Object.hasOwn(row, "actual_volume") && !isFiniteOrNull(row.actual_volume)) return false;
  if (Object.hasOwn(row, "prior_close") && !isFiniteOrNull(row.prior_close)) return false;
  if (Object.hasOwn(row, "session_return") && !isFiniteOrNull(row.session_return)) return false;
  if (Object.hasOwn(row, "intraday_reference_return") && !isFiniteOrNull(row.intraday_reference_return)) return false;
  if (Object.hasOwn(row, "quote_at") && row.quote_at !== null && typeof row.quote_at !== "string") return false;
  if (Object.hasOwn(row, "quote_age_seconds") && !isFiniteOrNull(row.quote_age_seconds)) return false;
  if (Object.hasOwn(row, "market_status") && row.market_status !== null && typeof row.market_status !== "string") return false;
  if (Object.hasOwn(row, "features")) {
    if (!row.features || typeof row.features !== "object" || Array.isArray(row.features)) return false;
    const featureFields = ["previous_return", "momentum", "volatility", "lookback_sessions"];
    if (!featureFields.every((field) => isFiniteOrNull(row.features[field]))) return false;
    if (row.features.lookback_sessions !== null && !Number.isInteger(row.features.lookback_sessions)) return false;
    if (Object.keys(row.features).some((field) => !featureFields.includes(field))) return false;
  }
  if (Object.hasOwn(row, "quality") && row.quality !== null && typeof row.quality !== "string") return false;
  if ((Object.hasOwn(row, "trading_status") || Object.hasOwn(row, "no_trade_evidence")) && !isNoTradeEvidence(row)) return false;
  if (row.expected_return !== deriveExpectedReturn(row)) return false;
  if (row.error !== deriveEvaluationError(row)) return false;
  return RANKING_FIELDS.every((field) => isFiniteOrNull(row[field]));
}

export function validateRankingRows(rows, { koreanSymbols = false } = {}) {
  if (!Array.isArray(rows)) return { valid: false, rows: [], reason: "Provider rows must be an array." };
  if (!rows.every(isRankingRow)) return { valid: false, rows: [], reason: "Provider rows do not satisfy the ranking row schema." };
  if (koreanSymbols && !rows.every(row => isKoreanSymbol(row.symbol))) return { valid: false, rows: [], reason: "Naver rows contain invalid Korean stock symbols." };
  return { valid: true, rows };
}

export function isSourceMetadata(source) {
  return Boolean(
    source &&
    typeof source === "object" &&
    typeof source.name === "string" &&
    typeof source.url === "string" &&
    typeof source.license_status === "string" &&
    (source.license_url === null || typeof source.license_url === "string") &&
    (source.retrieved_at === null || typeof source.retrieved_at === "string") &&
    (source.source_id === undefined || typeof source.source_id === "string") &&
    (source.run_id === undefined || typeof source.run_id === "string") &&
    (source.status === undefined || typeof source.status === "string") &&
    (source.fetched_at === undefined || typeof source.fetched_at === "string") &&
    (source.source_date === undefined || source.source_date === null || typeof source.source_date === "string") &&
    (source.raw_rows === undefined || Number.isInteger(source.raw_rows)) &&
    (source.source_rows === undefined || Number.isInteger(source.source_rows)) &&
    (source.partial === undefined || typeof source.partial === "boolean") &&
    (source.metrics === undefined || (source.metrics && typeof source.metrics === "object")),
  );
}

export function createSourceMetadata({
  name,
  url,
  licenseStatus,
  licenseUrl = null,
  retrievedAt = null,
  sourceId,
  runId,
  status,
  fetchedAt,
  sourceDate,
  rawRows,
  sourceRows,
  partial,
  metrics,
}) {
  const metadata = {
    name: name || "알 수 없는 출처",
    url: url || "",
    license_status: licenseStatus || "unknown",
    license_url: licenseUrl,
    retrieved_at: retrievedAt,
  };
  if (sourceId !== undefined) metadata.source_id = sourceId;
  if (runId !== undefined) metadata.run_id = runId;
  if (status !== undefined) metadata.status = status;
  if (fetchedAt !== undefined) metadata.fetched_at = fetchedAt;
  if (sourceDate !== undefined) metadata.source_date = sourceDate;
  if (rawRows !== undefined) metadata.raw_rows = rawRows;
  if (sourceRows !== undefined) metadata.source_rows = sourceRows;
  if (partial !== undefined) metadata.partial = partial;
  if (metrics !== undefined) metadata.metrics = metrics;
  return metadata;
}

export function isProviderResult(result) {
  if (!result || typeof result !== "object") return false;
  if (!SNAPSHOT_STATUSES.includes(result.status)) return false;
  if (typeof result.message !== "string") return false;
  if (!validateRankingRows(result.rows).valid) return false;
  if (result.source !== null && !isSourceMetadata(result.source)) return false;
  return result.asOfDate === null || typeof result.asOfDate === "string";
}

export function isSnapshot(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.schemaVersion !== "1.0.0" || !SNAPSHOT_STATUSES.includes(candidate.status)) return false;
  if (!(["provider", "demo", "fixture", "replay", "backfill_test", "historical_test"].includes(candidate.mode))) return false;
  if (!candidate.market || candidate.market.name !== "KOSPI" || candidate.market.currency !== "KRW") return false;
  if (!validateRankingRows(candidate.rows, { koreanSymbols: candidate.provider?.id === "naver-crawl" }).valid) return false;
  // Daily bars used by a stored basis must predate the snapshot's own date.
  if (typeof candidate.asOfDate === "string" && candidate.rows.some((row) => [row.expected_open_basis, row.expected_close_basis].some((basis) => basis?.history_dates?.length && !(basis.history_dates[0] < candidate.asOfDate)))) return false;
  if (candidate.provider !== null && typeof candidate.provider !== "object") return false;
  if (!candidate.meta || typeof candidate.meta !== "object" || !Object.hasOwn(candidate.meta, "source")) return false;
  if (candidate.meta.source !== null && !isSourceMetadata(candidate.meta.source)) return false;
  if (candidate.evaluation !== undefined && !isEvaluationSummary(candidate.evaluation)) return false;
  if (candidate.evaluation && candidate.evaluation.sample_count !== candidate.rows.filter((row) => !isNoTradeRow(row)).length) return false;
  if (candidate.evaluation && candidate.evaluation.evaluated_sample_count !== candidate.rows.filter((row) => evaluationRowStatus(row) === "evaluated").length) return false;
  if (["fixture", "replay", "backfill_test"].includes(candidate.mode) && candidate.meta.isDemo !== true) return false;
  if (candidate.mode === "backfill_test" && (candidate.meta.backfill !== true || candidate.provider?.id !== "backfill-test")) return false;
  if (candidate.mode === "historical_test" && (candidate.meta.historical_test !== true || candidate.meta.test_only !== true || candidate.provider?.id !== "historical-test")) return false;
  if (candidate.mode === "historical_test" && (candidate.evaluation?.test_only !== true || candidate.evaluation?.dataset !== "historical_test")) return false;
  if (candidate.meta.evaluation_test_only === true && candidate.evaluation?.test_only !== true) return false;
  if (!candidate.pipeline || !PIPELINE_KEYS.every((key) => candidate.pipeline[key])) return false;
  return true;
}

export function emptyRow(overrides = {}) {
  return {
    rank: null,
    symbol: null,
    name: null,
    expected_open: null,
    expected_close: null,
    expected_return: null,
    actual_open: null,
    actual_close: null,
    actual_return: null,
    session_return: null,
    intraday_reference_return: null,
    error: null,
    confidence: null,
    quality: "no_data",
    status: "no_data",
    ...overrides,
  };
}

export function noDataSnapshot({ mode = "provider", provider = null, message = "데이터 공급자가 연결되지 않았습니다." } = {}) {
  return {
    schemaVersion: "1.0.0",
    status: mode === "demo" ? "demo" : "no_data",
    mode,
    asOfDate: null,
    publishedAt: null,
    market: { name: "KOSPI", currency: "KRW", timezone: "Asia/Seoul" },
    provider,
    pipeline: {
      previousResult: { status: "pending", attemptedAt: null, provider_id: null, message: null },
      analysis: { status: "pending", attemptedAt: null, provider_id: null, message: null },
      forecast: { status: "pending", attemptedAt: null, provider_id: null, message: null },
      openSettlement: { status: "pending", attemptedAt: null, provider_id: null, message: null },
      closeSettlement: { status: "pending", attemptedAt: null, provider_id: null, message: null },
    },
    rows: [],
    meta: {
      generatedBy: "provider-adapter",
      lastAttemptAt: null,
      lastAttemptMode: null,
      blockedReason: message,
      isDemo: mode === "demo",
      source: provider?.source || null,
    },
  };
}
