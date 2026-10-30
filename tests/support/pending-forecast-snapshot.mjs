// Test fixture only: a fixed operational snapshot taken before the forecast
// stage (pipeline.forecast pending), with one ordinary row that has no
// expected_open and no stored basis. Replaces reading data/latest-snapshot.json,
// which the scheduler rewrites (its first null row may be no_trade or absent).
export const PENDING_FORECAST_SNAPSHOT = Object.freeze({
  provider: { id: "naver-crawl" },
  meta: { run_stage: "analysis", source: { license_status: "unconfirmed" } },
  pipeline: { forecast: { status: "pending" }, openSettlement: { status: "pending" }, closeSettlement: { status: "pending" } },
  rows: [
    { rank: 1, symbol: "000020", name: "동화약품", expected_open: null, expected_close: null, expected_return: null, actual_open: null, actual_close: null, actual_return: null, session_return: null, actual_volume: null, prior_close: 5200, prior_close_source: "naver_polling_close_minus_change", error: null, confidence: null, quality: "naver_preopen_quote", status: "valid", quote_at: "2026-10-29T23:00:41.000Z", quote_age_seconds: 3.14, market_status: "PREOPEN" },
  ],
});
