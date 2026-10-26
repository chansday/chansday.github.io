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

export const OPTIONAL_ROW_FIELDS = Object.freeze(["confidence", "quality", "actual_volume"]);

export const SNAPSHOT_STATUSES = Object.freeze([
  "ready",
  "demo",
  "no_data",
  "degraded",
  "blocked",
  "pending",
]);

export const PIPELINE_KEYS = Object.freeze([
  "previousResult",
  "analysis",
  "forecast",
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
  if (Object.hasOwn(row, "actual_volume") && !isFiniteOrNull(row.actual_volume)) return false;
  if (Object.hasOwn(row, "quality") && row.quality !== null && typeof row.quality !== "string") return false;
  return RANKING_FIELDS.every((field) => isFiniteOrNull(row[field]));
}

export function validateRankingRows(rows) {
  if (!Array.isArray(rows)) return { valid: false, rows: [], reason: "Provider rows must be an array." };
  if (!rows.every(isRankingRow)) return { valid: false, rows: [], reason: "Provider rows do not satisfy the ranking row schema." };
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
    (source.retrieved_at === null || typeof source.retrieved_at === "string"),
  );
}

export function createSourceMetadata({
  name,
  url,
  licenseStatus,
  licenseUrl = null,
  retrievedAt = null,
}) {
  return {
    name: name || "알 수 없는 출처",
    url: url || "",
    license_status: licenseStatus || "unknown",
    license_url: licenseUrl,
    retrieved_at: retrievedAt,
  };
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
  if (!validateRankingRows(candidate.rows).valid) return false;
  if (candidate.provider !== null && typeof candidate.provider !== "object") return false;
  if (!candidate.meta || typeof candidate.meta !== "object" || !Object.hasOwn(candidate.meta, "source")) return false;
  if (candidate.meta.source !== null && !isSourceMetadata(candidate.meta.source)) return false;
  if (["fixture", "replay", "backfill_test"].includes(candidate.mode) && candidate.meta.isDemo !== true) return false;
  if (candidate.mode === "backfill_test" && (candidate.meta.backfill !== true || candidate.provider?.id !== "backfill-test")) return false;
  if (candidate.mode === "historical_test" && (candidate.meta.historical_test !== true || candidate.meta.test_only !== true || candidate.provider?.id !== "historical-test")) return false;
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
