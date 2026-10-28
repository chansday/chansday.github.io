// Test helper: Naver list/quote/chart hosts answer robots.txt with HTTP 404
// (observed 2026-10-28). Other robots.txt requests reach the test's own mock.
// The committed universe list is replaced by a missing path unless a test sets
// KOSPI_UNIVERSE_CACHE, so tests never depend on the repository data file.
export const NAVER_ROBOTS_URLS = new Set([
  "https://api.stock.naver.com/robots.txt",
  "https://polling.finance.naver.com/robots.txt",
]);
export const MISSING_UNIVERSE_CACHE = "tests/__missing_universe_cache__.json";

export function naverRobotsFetch(fetchImpl, { status = 404, text = "" } = {}) {
  return async (url, init) => NAVER_ROBOTS_URLS.has(String(url))
    ? { ok: status === 200, status, headers: new Headers({ "content-type": status === 200 ? "text/plain" : "application/json" }), text: async () => text }
    : fetchImpl(url, init);
}

export function withNaverRobots(options = {}) {
  return {
    ...options,
    env: { KOSPI_UNIVERSE_CACHE: MISSING_UNIVERSE_CACHE, ...(options.env || {}) },
    ...(options.fetchImpl ? { fetchImpl: naverRobotsFetch(options.fetchImpl) } : {}),
  };
}
