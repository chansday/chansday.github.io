import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNaverCrawlProvider, isChallenge } from "../providers/naver-crawl-provider.js";
import { loadKospiUniverseCache, KOSPI_UNIVERSE_PATH } from "../providers/kospi-universe-cache.js";
import { dailyHistoryPath } from "../providers/naver-daily-cache.js";
import { REPO_ROOT, displayPath, repoPath } from "../providers/repo-paths.js";
import { buildUniverseRecord, updateUniverse } from "../scripts/update-kospi-universe.mjs";

const json = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(payload) });
const text = (body, status = 200, type = "text/plain") => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": type }), text: async () => body });
const quote = (symbol, extra = {}) => ({ symbolCode: symbol, stockName: symbol, openPriceRaw: 100, closePriceRaw: 110, localTradedAt: "2026-10-27T10:00:00+09:00", marketStatus: "OPEN", stockExchangeType: { code: "KS" }, ...extra });
const naverRoutes = (stocks, quoteFor, extra = {}) => async (url) => {
  const u = new URL(url), key = `${u.origin}${u.pathname}`;
  if (key === "https://api.stock.naver.com/robots.txt" || key === "https://polling.finance.naver.com/robots.txt") return text("{}", 404, "application/json");
  if (key === "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue") return json({ totalCount: stocks.length, stocks });
  if (key.startsWith("https://polling.finance.naver.com/api/realtime/domestic/stock/")) return quoteFor(url);
  if (extra[key]) return extra[key];
  throw new Error(`unexpected request ${url}`);
};
const env = (extra = {}) => ({ KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0", KOSPI_UNIVERSE_CACHE: "tests/__missing__.json", ...extra });

// Defect 1(b): settlement must not be degraded by missing prior history.
test("missing Naver history cache leaves settlement ready but keeps forecast degraded", async () => {
  const root = await mkdtemp(join(tmpdir(), "kospi-qa-history-"));
  const before = process.env.KOSPI_DATA_ROOT; process.env.KOSPI_DATA_ROOT = root;
  try {
    const fetchImpl = naverRoutes([{ itemCode: "005930", stockName: "A" }], () => json({ datas: [quote("005930")] }));
    const openTime = new Date("2026-10-27T01:00:00Z");
    const opened = await createNaverCrawlProvider({ env: env({ KOSPI_DAILY_HISTORY: "naver-cache" }), fetchImpl, now: () => openTime, runStartedAt: openTime.toISOString() }).settleOpen();
    assert.equal(opened.status, "ready"); assert.equal(opened.rows[0].actual_open, 100); assert.equal(opened.rows[0].expected_open, null);
    assert.equal(opened.source.metrics.history_status, "degraded"); assert.match(opened.source.metrics.history_reason, /Naver daily history unavailable/);
    assert.match(opened.message, /settlement prices unaffected/);
    const closeTime = new Date("2026-10-27T06:40:00Z");
    const closeFetch = naverRoutes([{ itemCode: "005930", stockName: "A" }], () => json({ datas: [quote("005930", { localTradedAt: "2026-10-27T15:35:00+09:00", marketStatus: "CLOSE" })] }));
    const closed = await createNaverCrawlProvider({ env: env({ KOSPI_DAILY_HISTORY: "naver-cache" }), fetchImpl: closeFetch, now: () => closeTime, runStartedAt: closeTime.toISOString() }).settleClose();
    assert.equal(closed.status, "ready"); assert.equal(closed.rows[0].actual_close, 110); assert.equal(closed.source.metrics.history_status, "degraded");
    const forecastTime = new Date("2026-10-26T23:20:00Z");
    const preFetch = naverRoutes([{ itemCode: "005930", stockName: "A" }], () => json({ datas: [quote("005930", { localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN" })] }));
    const forecast = await createNaverCrawlProvider({ env: env({ KOSPI_DAILY_HISTORY: "naver-cache" }), fetchImpl: preFetch, now: () => forecastTime, runStartedAt: forecastTime.toISOString() }).generateForecast();
    assert.equal(forecast.status, "degraded"); assert.match(forecast.message, /history unavailable/i);
  } finally { if (before === undefined) delete process.env.KOSPI_DATA_ROOT; else process.env.KOSPI_DATA_ROOT = before; await rm(root, { recursive: true, force: true }); }
});

// Defect 1(a): collection starts early enough for the 08:00 KST cutoff.
test("daily history is dispatched at 06:10 KST with a 07:10 retry and refreshes the universe from the latest CSV", async () => {
  const yml = await readFile(new URL("../.github/workflows/naver-daily-history.yml", import.meta.url), "utf8");
  assert.doesNotMatch(yml, /cron:/); assert.match(yml, /workflow_dispatch:/);
  const { STAGES } = await import("../scripts/scheduler-plan.mjs");
  const history = STAGES.find((s) => s.id === "naver-daily-history");
  assert.equal(history.at, "06:10"); assert.equal(history.retry.at, "07:10"); assert.ok(history.lastStart < "08:00");
  assert.match(yml, /update-kospi-universe\.mjs --candidates-csv latest/);
});

// Defect 3: JSON bodies are not keyword-matched as challenges.
test("valid JSON naming a robotics or forbidden-sounding stock is data, not a challenge", async () => {
  assert.equal(isChallenge(JSON.stringify({ datas: [{ stockName: "두산로보틱스 Doosan Robotics" }] }), "application/json"), false);
  assert.equal(isChallenge("Access denied", "text/plain"), true);
  assert.equal(isChallenge("<html>robot check</html>", "text/html"), true);
  assert.equal(isChallenge("{}", "text/html; charset=utf-8"), true);
  const time = new Date("2026-10-26T23:20:00Z");
  const fetchImpl = naverRoutes([{ itemCode: "454910", stockName: "두산로보틱스 Doosan Robotics" }, { itemCode: "005930", stockName: "Forbidden City Too Many Requests" }],
    () => json({ datas: [quote("454910", { stockName: "두산로보틱스 Doosan Robotics", localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN" }), quote("005930", { stockName: "Forbidden City Too Many Requests", localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN" })] }));
  const result = await createNaverCrawlProvider({ env: env(), fetchImpl, now: () => time, runStartedAt: time.toISOString() }).generateForecast();
  assert.equal(result.status, "ready"); assert.equal(result.rows.length, 2);
  const blockedFetch = naverRoutes([{ itemCode: "005930", stockName: "A" }], () => text("Access denied", 200, "text/plain"));
  const blocked = await createNaverCrawlProvider({ env: env(), fetchImpl: blockedFetch, now: () => time, runStartedAt: time.toISOString() }).generateForecast();
  assert.equal(blocked.status, "blocked"); assert.match(blocked.message, /challenge/);
});

// Defect 4: 429/Retry-After stops immediately without a pointless wait or retry.
test("429 with Retry-After stops at once, once, and records the retry time", async () => {
  const time = new Date("2026-10-26T23:20:00Z");
  let listCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/robots.txt")) return text("{}", 404, "application/json");
    listCalls += 1;
    return { ok: false, status: 429, headers: new Headers({ "content-type": "application/json", "retry-after": "30" }), text: async () => "{}" };
  };
  const started = Date.now();
  const result = await createNaverCrawlProvider({ env: env({ KOSPI_CRAWL_MAX_RETRIES: "2" }), fetchImpl, now: () => time, runStartedAt: time.toISOString() }).generateForecast();
  assert.ok(Date.now() - started < 5000, "must not sleep for Retry-After");
  assert.equal(result.status, "blocked"); assert.equal(listCalls, 1); assert.match(result.message, /retry not before/);
});

// Defect 2: re-verification preserves candidate provenance and staleness.
test("re-verifying the list keeps candidates_as_of, collected_at and candidate_source; staleness follows candidates_as_of", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-qa-universe-"));
  try {
    const output = join(dir, "u.json");
    const source = { url: "https://aikstockdata.com/data/public/daily/quotes_20261016.csv", basDt: "2026-10-16" };
    await writeFile(output, JSON.stringify(buildUniverseRecord({ method: "candidate_verification", symbols: [{ symbol: "005930", name: "A" }], collectedAt: "2026-10-17T00:00:00Z", candidatesAsOf: "2026-10-16", verifiedAt: "2026-10-17T00:00:00Z", candidateSource: source })));
    const fetchImpl = naverRoutes([], () => json({ datas: [quote("005930")] }));
    for (const at of ["2026-10-26T21:10:00Z", "2026-10-27T21:10:00Z"]) {
      const result = await updateUniverse({ outputPath: output, fetchImpl, now: () => new Date(at) });
      assert.equal(result.status, "updated");
    }
    const record = JSON.parse(await readFile(output, "utf8"));
    assert.equal(record.candidates_as_of, "2026-10-16"); assert.equal(record.collected_at, "2026-10-17T00:00:00Z"); assert.equal(record.verified_at, "2026-10-27T21:10:00.000Z");
    assert.deepEqual(record.candidate_source, source);
    assert.ok(!JSON.stringify(record).includes("previous_candidate_source"));
    const cache = await loadKospiUniverseCache({ path: output, now: () => new Date("2026-10-27T21:20:00Z") });
    assert.equal(cache.ok, true); assert.equal(cache.stale, true, "re-verification must not reset staleness");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("--candidates-csv latest picks the newest newer CSV, skips unpublished days, and otherwise re-verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-qa-universe-"));
  try {
    const output = join(dir, "u.json");
    await writeFile(output, JSON.stringify(buildUniverseRecord({ method: "candidate_verification", symbols: [{ symbol: "005930", name: "A" }], collectedAt: "2026-10-24T00:00:00Z", candidatesAsOf: "2026-10-23", verifiedAt: "2026-10-24T00:00:00Z", candidateSource: { basDt: "2026-10-23" } })));
    const robots = "User-agent: *\nAllow: /data/public/\nDisallow: /data/\n";
    const csv = "basDt,종목코드,종목명,mrktCtg\n20261026,005930,삼성전자,KOSPI\n";
    const csvRequests = [];
    const extra = {
      "https://aikstockdata.com/robots.txt": text(robots),
      "https://aikstockdata.com/data/public/daily/quotes_20261027.csv": text("", 404),
      "https://aikstockdata.com/data/public/daily/quotes_20261026.csv": text(csv, 200, "text/csv"),
    };
    const routes = naverRoutes([], () => json({ datas: [quote("005930")] }), extra);
    const fetchImpl = async (url, init) => { if (String(url).endsWith(".csv")) csvRequests.push(String(url)); return routes(url, init); };
    const now = () => new Date("2026-10-27T21:10:00Z"); // 2026-10-28 06:10 KST
    const updated = await updateUniverse({ candidatesCsvDate: "latest", outputPath: output, fetchImpl, now });
    assert.equal(updated.status, "updated"); assert.equal(updated.candidates_as_of, "2026-10-26");
    assert.deepEqual(csvRequests.map(u => u.slice(-12)), ["20261027.csv", "20261026.csv"]);
    let record = JSON.parse(await readFile(output, "utf8"));
    assert.equal(record.candidates_as_of, "2026-10-26"); assert.equal(record.candidate_source.basDt, "2026-10-26");
    csvRequests.length = 0;
    const again = await updateUniverse({ candidatesCsvDate: "latest", outputPath: output, fetchImpl, now });
    assert.equal(again.status, "updated"); assert.deepEqual(csvRequests.map(u => u.slice(-12)), ["20261027.csv"]);
    record = JSON.parse(await readFile(output, "utf8"));
    assert.equal(record.candidates_as_of, "2026-10-26", "fallback re-verification keeps the CSV date");
    const blockedFetch = naverRoutes([], () => json({ datas: [quote("005930")] }), { "https://aikstockdata.com/robots.txt": text("User-agent: *\nDisallow: /\n") });
    const blocked = await updateUniverse({ candidatesCsvDate: "latest", outputPath: join(dir, "missing.json"), fetchImpl: blockedFetch, now });
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.written, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Defect 5: data paths resolve from the repository root, not process.cwd().
test("universe and daily-history paths resolve from the repository root regardless of cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-qa-cwd-")), old = process.cwd();
  const before = process.env.KOSPI_DATA_ROOT; delete process.env.KOSPI_DATA_ROOT;
  try {
    process.chdir(dir);
    assert.equal(repoPath(KOSPI_UNIVERSE_PATH), join(REPO_ROOT, "data", "kospi-universe.json"));
    assert.equal(dailyHistoryPath("2026-10-28"), join(REPO_ROOT, "data", "daily-history", "2026-10-28.json"));
    assert.equal(displayPath(KOSPI_UNIVERSE_PATH), "data/kospi-universe.json");
    const cache = await loadKospiUniverseCache({ now: () => new Date("2026-10-28T08:00:00Z") });
    assert.equal(cache.ok, true, cache.reason); assert.equal(cache.path, "data/kospi-universe.json");
    process.env.KOSPI_DATA_ROOT = dir;
    assert.equal(dailyHistoryPath("2026-10-28"), join(dir, "data", "daily-history", "2026-10-28.json"));
    assert.equal((await loadKospiUniverseCache()).ok, false);
  } finally { process.chdir(old); if (before === undefined) delete process.env.KOSPI_DATA_ROOT; else process.env.KOSPI_DATA_ROOT = before; await rm(dir, { recursive: true, force: true }); }
});

// QA 6: falling quotes used to store the current price as prior_close because
// the signed change ("-15") was rejected and the code fell back to the close.
test("prior_close is close minus the signed polling change and is never the current price", async () => {
  const { quotePriorClose, PRIOR_CLOSE_SOURCE } = await import("../providers/naver-crawl-provider.js");
  const q = (close, change, code) => ({ closePriceRaw: close, compareToPreviousClosePriceRaw: change, ...(code ? { compareToPreviousPrice: { code } } : {}) });
  assert.equal(quotePriorClose(q("5220", "20", "2")), 5200);        // rising (observed 000020, 2026-10-28)
  assert.equal(quotePriorClose(q("1117", "-15", "5")), 1132);       // falling (observed 000040, 2026-10-28)
  assert.equal(quotePriorClose(q("244000", "22000", "2")), 222000);
  assert.equal(quotePriorClose(q("1,000", "0", "3")), 1000);        // unchanged
  assert.equal(quotePriorClose(q("1300", "300", "1")), 1000);       // upper limit
  assert.equal(quotePriorClose(q("700", "-300", "4")), 1000);       // lower limit
  assert.equal(quotePriorClose(q("1117", "15", "5")), null, "direction says falling but change is positive");
  assert.equal(quotePriorClose(q("1117", "-15", "2")), null);
  assert.equal(quotePriorClose(q("1117", "", "5")), null);
  assert.equal(quotePriorClose(q("1117", undefined)), null);
  assert.equal(quotePriorClose(q("10", "-10x")), null);
  assert.equal(quotePriorClose(q("10", "10", "2")), null, "non-positive prior close");
  const time = new Date("2026-10-27T01:00:00Z");
  const fetchImpl = naverRoutes([{ itemCode: "000040", stockName: "KR" }, { itemCode: "000020", stockName: "DH" }], () => json({ datas: [
    quote("000040", { closePriceRaw: 1117, openPriceRaw: 1102, compareToPreviousClosePriceRaw: "-15", compareToPreviousPrice: { code: "5" } }),
    quote("000020", { closePriceRaw: 5220, openPriceRaw: 5200, compareToPreviousClosePriceRaw: "20", compareToPreviousPrice: { code: "2" } }),
  ] }));
  const result = await createNaverCrawlProvider({ env: env(), fetchImpl, now: () => time, runStartedAt: time.toISOString() }).settleOpen();
  const bySymbol = Object.fromEntries(result.rows.map((r) => [r.symbol, r]));
  assert.equal(bySymbol["000040"].prior_close, 1132); assert.notEqual(bySymbol["000040"].prior_close, 1117);
  assert.equal(bySymbol["000020"].prior_close, 5200); assert.equal(bySymbol["000020"].actual_open, 5200, "opening at the reference price is legitimate");
  assert.equal(bySymbol["000040"].prior_close_source, PRIOR_CLOSE_SOURCE);
  const missing = await createNaverCrawlProvider({ env: env(), fetchImpl: naverRoutes([{ itemCode: "005930", stockName: "A" }], () => json({ datas: [quote("005930")] })), now: () => time, runStartedAt: time.toISOString() }).settleOpen();
  assert.equal(missing.rows[0].prior_close, null); assert.equal(Object.hasOwn(missing.rows[0], "prior_close_source"), false);
});
