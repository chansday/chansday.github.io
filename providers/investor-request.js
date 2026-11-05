// Shared request policy of the investor-flow collectors (daily and backfill),
// as chosen by the repository owner for the secondary source:
// - HTTP 403: switch to the next User-Agent and retry after a growing wait
//   (BLOCK_WAIT_MS, doubling); stop once every User-Agent was refused.
// - HTTP 429: wait Retry-After (<= 120 s, 60 s when absent), up to 3 retries;
//   a longer Retry-After stops immediately.
// - HTTP 5xx, timeouts and network errors: up to 3 retries (5 s, 15 s, 45 s).
// - The User-Agent that last succeeded is kept for the following requests.
// Callers keep their own 1 s pacing between symbols.
// Logging: every retry, User-Agent switch, recovery after a retry, final
// refusal (with status, attempt, User-Agent number, response time and a short
// body excerpt) is logged; request.stats() returns running counters.
export const INVESTOR_USER_AGENTS = Object.freeze([
  "kospi-signal-personal-investor-collector/1.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
]);
export const USER_AGENT_LABELS = Object.freeze(["수집기", "PC 크롬", "PC 엣지", "아이폰 사파리", "안드로이드 크롬"]);
export const BLOCK_WAIT_MS = 30_000;
export const RATE_LIMIT_RETRIES = 3;
export const TRANSIENT_WAITS_MS = Object.freeze([5_000, 15_000, 45_000]);
const MAX_RETRY_AFTER_S = 120;

const uaName = (agents, i) => `UA ${i + 1}/${agents.length}${agents === INVESTOR_USER_AGENTS ? `(${USER_AGENT_LABELS[i]})` : ""}`;

// A short, single-line excerpt of an error body for the log (never the data of
// a successful response).
async function excerpt(response) {
  try { const text = typeof response.clone === "function" ? await response.clone().text() : ""; return text.replace(/\s+/g, " ").trim().slice(0, 160); } catch { return ""; }
}

export function formatRequestStats(s) {
  const statuses = Object.entries(s.by_status).sort().map(([k, v]) => `${k}:${v}`).join(" ") || "-";
  const errors = Object.entries(s.errors).map(([k, v]) => `${k}:${v}`).join(" ") || "-";
  return `요청 ${s.requests} · 상태 ${statuses} · 오류 ${errors} · UA 전환 ${s.ua_switches} · 429 대기 ${s.rate_limit_waits} · 일시 오류 재시도 ${s.transient_retries} · 재시도 후 성공 ${s.recovered} · 대기 합계 ${Math.round(s.wait_ms / 1000)}초 · 현재 ${s.current_user_agent} · 평균 응답 ${s.requests ? Math.round(s.response_ms / s.requests) : 0}ms`;
}

export function createInvestorRequester({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, userAgents = INVESTOR_USER_AGENTS, timeoutMs = 12_000, clock = () => Date.now() } = {}) {
  if (!Array.isArray(userAgents) || !userAgents.length) throw new Error("At least one User-Agent is required");
  let current = 0;
  const stats = { requests: 0, by_status: {}, errors: {}, ua_switches: 0, rate_limit_waits: 0, transient_retries: 0, recovered: 0, wait_ms: 0, response_ms: 0, current_user_agent: uaName(userAgents, 0), ua_success: Object.fromEntries(userAgents.map((_, i) => [uaName(userAgents, i), 0])) };
  const wait = async (ms) => { stats.wait_ms += ms; await sleep(ms); };

  // Returns { response } (any status the policy does not retry, or the final
  // one) or { error } for a request that never got a response; `requests`
  // counts every request sent for this URL.
  async function request(url, label = "") {
    let requests = 0, rotations = 0, rateLimited = 0, transient = 0;
    const tag = label || "보조 수집";
    for (;;) {
      requests++; stats.requests++;
      const agent = uaName(userAgents, current), started = clock();
      let response;
      try {
        response = await fetchImpl(url, { headers: { "User-Agent": userAgents[current], Accept: "application/json", "Accept-Language": "ko-KR,ko;q=0.9" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        const ms = clock() - started, name = error?.name || "Error";
        stats.response_ms += ms; stats.errors[name] = (stats.errors[name] || 0) + 1;
        if (transient < TRANSIENT_WAITS_MS.length) { const ms2 = TRANSIENT_WAITS_MS[transient++]; stats.transient_retries++; log(`${tag} · ${name === "TimeoutError" ? "시간 초과" : `요청 오류(${name}: ${String(error?.message || "").slice(0, 80)})`} · ${agent} · 시도 ${requests} · ${ms}ms · ${ms2 / 1000}초 후 재시도 ${transient}/${TRANSIENT_WAITS_MS.length}`); await wait(ms2); continue; }
        log(`${tag} · ${name} · ${agent} · 시도 ${requests} · 재시도 소진, 포기`);
        return { error, requests };
      }
      const ms = clock() - started;
      stats.response_ms += ms; stats.by_status[response.status] = (stats.by_status[response.status] || 0) + 1;
      if (response.status === 403 && rotations < userAgents.length - 1) {
        const pause = BLOCK_WAIT_MS * 2 ** rotations, body = await excerpt(response);
        rotations++; current = (current + 1) % userAgents.length; stats.ua_switches++; stats.current_user_agent = uaName(userAgents, current);
        log(`${tag} · HTTP 403 · ${agent} · 시도 ${requests} · ${ms}ms${body ? ` · 응답 "${body}"` : ""} · ${uaName(userAgents, current)}로 바꿔 ${pause / 1000}초 후 재시도`);
        await wait(pause); continue;
      }
      if (response.status === 429) {
        const header = response.headers.get("retry-after"), seconds = header && /^\d+$/.test(header) ? Number(header) : 60;
        if (seconds > MAX_RETRY_AFTER_S) { log(`${tag} · HTTP 429 · ${agent} · Retry-After ${header}초가 허용 범위(${MAX_RETRY_AFTER_S}초)를 넘어 중단`); return { response, requests }; }
        if (rateLimited < RATE_LIMIT_RETRIES) { rateLimited++; stats.rate_limit_waits++; log(`${tag} · HTTP 429 · ${agent} · 시도 ${requests} · Retry-After ${header ?? "없음"} · ${Math.max(seconds, 1)}초 대기 후 재시도 ${rateLimited}/${RATE_LIMIT_RETRIES}`); await wait(Math.max(seconds, 1) * 1000); continue; }
        log(`${tag} · HTTP 429 · ${agent} · 재시도 ${RATE_LIMIT_RETRIES}회 소진, 포기`);
        return { response, requests };
      }
      if (response.status >= 500 && transient < TRANSIENT_WAITS_MS.length) { const pause = TRANSIENT_WAITS_MS[transient++]; stats.transient_retries++; log(`${tag} · HTTP ${response.status} · ${agent} · 시도 ${requests} · ${ms}ms · ${pause / 1000}초 후 재시도 ${transient}/${TRANSIENT_WAITS_MS.length}`); await wait(pause); continue; }
      if (response.ok) {
        stats.ua_success[agent]++;
        if (requests > 1) stats.recovered++;
        log(`${tag} · HTTP ${response.status} · ${agent} · 시도 ${requests}에서 성공 · ${ms}ms`);
      } else {
        const body = await excerpt(response);
        log(`${tag} · HTTP ${response.status} · ${agent} · 시도 ${requests} · ${ms}ms${body ? ` · 응답 "${body}"` : ""} · ${response.status === 403 ? "모든 User-Agent 거부, 중단" : "재시도 대상 아님, 중단"}`);
      }
      return { response, requests };
    }
  }
  request.stats = () => JSON.parse(JSON.stringify(stats));
  return request;
}
