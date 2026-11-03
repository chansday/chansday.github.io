// Shared request policy of the investor-flow collectors (daily and backfill),
// as chosen by the repository owner for m.stock.naver.com:
// - HTTP 403: switch to the next User-Agent and retry after a growing wait
//   (BLOCK_WAIT_MS, doubling); stop once every User-Agent was refused.
// - HTTP 429: wait Retry-After (<= 120 s, 60 s when absent), up to 3 retries;
//   a longer Retry-After stops immediately.
// - HTTP 5xx, timeouts and network errors: up to 3 retries (5 s, 15 s, 45 s).
// - The User-Agent that last succeeded is kept for the following requests.
// Callers keep their own 1 s pacing between symbols.
export const INVESTOR_USER_AGENTS = Object.freeze([
  "kospi-signal-personal-investor-collector/1.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
]);
export const BLOCK_WAIT_MS = 30_000;
export const RATE_LIMIT_RETRIES = 3;
export const TRANSIENT_WAITS_MS = Object.freeze([5_000, 15_000, 45_000]);
const MAX_RETRY_AFTER_S = 120;

export function createInvestorRequester({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, userAgents = INVESTOR_USER_AGENTS, timeoutMs = 12_000 } = {}) {
  if (!Array.isArray(userAgents) || !userAgents.length) throw new Error("At least one User-Agent is required");
  let current = 0;
  // Returns { response } (any status the policy does not retry, or the final
  // one) or { error } for a request that never got a response; `requests`
  // counts every request sent.
  return async function request(url, label = "") {
    let requests = 0, rotations = 0, rateLimited = 0, transient = 0;
    for (;;) {
      requests++;
      let response;
      try {
        response = await fetchImpl(url, { headers: { "User-Agent": userAgents[current], Accept: "application/json", "Accept-Language": "ko-KR,ko;q=0.9" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (transient < TRANSIENT_WAITS_MS.length) { const wait = TRANSIENT_WAITS_MS[transient++]; log(`${label} · ${error.name === "TimeoutError" ? "시간 초과" : "요청 오류"} · ${wait / 1000}초 후 재시도 ${transient}/${TRANSIENT_WAITS_MS.length}`); await sleep(wait); continue; }
        return { error, requests };
      }
      if (response.status === 403 && rotations < userAgents.length - 1) {
        const wait = BLOCK_WAIT_MS * 2 ** rotations;
        rotations++; current = (current + 1) % userAgents.length;
        log(`${label} · HTTP 403 · User-Agent ${current + 1}/${userAgents.length}로 바꿔 ${wait / 1000}초 후 재시도`);
        await sleep(wait); continue;
      }
      if (response.status === 429) {
        const header = response.headers.get("retry-after"), seconds = header && /^\d+$/.test(header) ? Number(header) : 60;
        if (seconds > MAX_RETRY_AFTER_S) { log(`${label} · HTTP 429 · 대기 시간이 허용 범위를 벗어나 수집 중단`); return { response, requests }; }
        if (rateLimited < RATE_LIMIT_RETRIES) { rateLimited++; log(`${label} · HTTP 429 · ${Math.max(seconds, 1)}초 대기 후 재시도 ${rateLimited}/${RATE_LIMIT_RETRIES}`); await sleep(Math.max(seconds, 1) * 1000); continue; }
        return { response, requests };
      }
      if (response.status >= 500 && transient < TRANSIENT_WAITS_MS.length) { const wait = TRANSIENT_WAITS_MS[transient++]; log(`${label} · HTTP ${response.status} · ${wait / 1000}초 후 재시도 ${transient}/${TRANSIENT_WAITS_MS.length}`); await sleep(wait); continue; }
      return { response, requests };
    }
  };
}
