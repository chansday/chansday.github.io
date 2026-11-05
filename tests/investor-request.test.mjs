import test from "node:test";
import assert from "node:assert/strict";
import { BLOCK_WAIT_MS, INVESTOR_USER_AGENTS, TRANSIENT_WAITS_MS, createInvestorRequester } from "../providers/investor-request.js";

const res = (status, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers) });
const URL_ = Buffer.from("aHR0cHM6Ly9tLnN0b2NrLm5hdmVyLmNvbS9hcGkvc3RvY2svMDA1OTMwL3RyZW5k","base64").toString("utf8");

test("403 rotates to the next User-Agent with a doubling wait and keeps the one that works", async () => {
  const agents = [], waits = [];
  const request = createInvestorRequester({ sleep: async (ms) => waits.push(ms), fetchImpl: async (u, init) => { agents.push(init.headers["User-Agent"]); return agents.length <= 2 ? res(403) : res(200); } });
  const first = await request(URL_);
  assert.equal(first.response.status, 200);
  assert.equal(first.requests, 3);
  assert.deepEqual(agents, INVESTOR_USER_AGENTS.slice(0, 3));
  assert.deepEqual(waits, [BLOCK_WAIT_MS, BLOCK_WAIT_MS * 2]);
  await request(URL_);
  assert.equal(agents.at(-1), INVESTOR_USER_AGENTS[2]);
});

test("403 from every User-Agent returns the final refusal", async () => {
  let calls = 0;
  const r = await createInvestorRequester({ sleep: async () => {}, fetchImpl: async () => { calls++; return res(403); } })(URL_);
  assert.equal(r.response.status, 403);
  assert.equal(calls, INVESTOR_USER_AGENTS.length);
});

test("429 waits Retry-After up to three times; a long Retry-After stops at once", async () => {
  const waits = [];
  let calls = 0;
  const limited = await createInvestorRequester({ sleep: async (ms) => waits.push(ms), fetchImpl: async () => { calls++; return res(429, { "retry-after": "7" }); } })(URL_);
  assert.equal(limited.response.status, 429);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [7000, 7000, 7000]);
  calls = 0;
  const long = await createInvestorRequester({ sleep: async () => { throw new Error("must not wait"); }, fetchImpl: async () => { calls++; return res(429, { "retry-after": "600" }); } })(URL_);
  assert.equal(long.response.status, 429);
  assert.equal(calls, 1);
});

test("5xx and network errors retry with 5/15/45 s waits", async () => {
  const waits = [];
  let calls = 0;
  const r = await createInvestorRequester({ sleep: async (ms) => waits.push(ms), fetchImpl: async () => { calls++; if (calls === 1) throw new TypeError("fetch failed"); return calls < 4 ? res(502) : res(200); } })(URL_);
  assert.equal(r.response.status, 200);
  assert.deepEqual(waits, [...TRANSIENT_WAITS_MS]);
  const down = await createInvestorRequester({ sleep: async () => {}, fetchImpl: async () => { throw new TypeError("fetch failed"); } })(URL_);
  assert.ok(down.error);
  assert.equal(down.requests, TRANSIENT_WAITS_MS.length + 1);
});

test("logs every retry, switch, recovery and final refusal, and keeps counters", async () => {
  const lines = [];
  let calls = 0;
  const request = createInvestorRequester({ log: (l) => lines.push(l), sleep: async () => {}, fetchImpl: async () => { calls++; return calls === 1 ? res(403) : calls === 2 ? res(503) : calls === 3 ? res(200) : res(404); } });
  await request(URL_, "005930");
  await request(URL_, "000660");
  const text = lines.join("\n");
  assert.match(text, /005930 · HTTP 403 · UA 1\/5\(수집기\) · 시도 1 .*UA 2\/5\(PC 크롬\)로 바꿔 30초 후 재시도/);
  assert.doesNotMatch(text, /\/api\/stock\//);
  assert.match(text, /HTTP 503 · UA 2\/5\(PC 크롬\) · 시도 2 .*5초 후 재시도 1\/3/);
  assert.match(text, /HTTP 200 · UA 2\/5\(PC 크롬\) · 시도 3에서 성공/);
  assert.match(text, /000660 .*HTTP 404 .*재시도 대상 아님, 중단/);
  const s = request.stats();
  assert.equal(s.requests, 4);
  assert.deepEqual(s.by_status, { 200: 1, 403: 1, 404: 1, 503: 1 });
  assert.equal(s.ua_switches, 1);
  assert.equal(s.transient_retries, 1);
  assert.equal(s.recovered, 1);
  assert.equal(s.wait_ms, 35_000);
  assert.equal(s.ua_success["UA 2/5(PC 크롬)"], 1);
});
