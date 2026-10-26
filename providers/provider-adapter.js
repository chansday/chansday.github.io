/**
 * Provider adapter contract for the static KOSPI board.
 *
 * A real adapter must expose these methods and return a provider result with
 * status, message, and (when verified) rows. This file intentionally contains
 * no network client and no credentials.
 */
export const PROVIDER_METHODS = Object.freeze([
  "fetchPreviousDay",
  "runAnalysis",
  "generateForecast",
]);

export const FINANCIAL_FIELDS = Object.freeze([
  "expectedOpen",
  "expectedClose",
  "expectedReturn",
  "actualOpen",
  "actualClose",
  "actualReturn",
  "error",
]);

export function isProviderAdapter(candidate) {
  return Boolean(
    candidate &&
    typeof candidate.id === "string" &&
    PROVIDER_METHODS.every((method) => typeof candidate[method] === "function"),
  );
}

export function isSnapshot(candidate) {
  return Boolean(
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.status === "string" &&
    Array.isArray(candidate.rows) &&
    candidate.rows.every((row) => row && typeof row === "object"),
  );
}

export function emptyRow(overrides = {}) {
  return {
    rank: null,
    symbol: null,
    name: null,
    expectedOpen: null,
    expectedClose: null,
    expectedReturn: null,
    actualOpen: null,
    actualClose: null,
    actualReturn: null,
    error: null,
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
      previousResult: { status: "pending", attemptedAt: null, message: null },
      analysis: { status: "pending", attemptedAt: null, message: null },
      forecast: { status: "pending", attemptedAt: null, message: null },
    },
    rows: [],
    meta: {
      generatedBy: "provider-adapter",
      lastAttemptAt: null,
      lastAttemptMode: null,
      blockedReason: message,
      isDemo: mode === "demo",
    },
  };
}

