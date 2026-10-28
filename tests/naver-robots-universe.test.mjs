import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRobotsUrl } from "../providers/robots-policy.js";
import { collectNaverUniverse, createNaverCrawlProvider, UNIVERSE_ENDPOINT, QUOTE_ENDPOINT } from "../providers/naver-crawl-provider.js";
import { loadKospiUniverseCache } from "../providers/kospi-universe-cache.js";
import { buildUniverseRecord, candidateSymbols, fetchCsvCandidates, isRefusedCandidatePath, updateUniverse } from "../scripts/update-kospi-universe.mjs";

const UA = "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)";
const time = new Date("2026-10-26T23:20:00Z");
const json = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(payload) });
const text = (body, status = 200, type = "text/plain") => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": type }), text: async () => body });
const quote = (symbol, extra = {}) => ({ symbolCode: symbol, stockName: symbol, openPriceRaw: 100, closePriceRaw: 100, localTradedAt: "2026-10-27T08:20:00+09:00", marketStatus: "PREOPEN", stockExchangeType: { code: "KS" }, ...extra });
// Observed 2026-10-28: m.stock.naver.com, finance.naver.com, fchart.stock.naver.com disallow all.
const DISALLOW_ALL = "User-agent: *\nDisallow: /\n";

function hostFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push(String(url));
    const u = new URL(url);
    const route = routes[`${u.origin}${u.pathname}`] ?? routes[u.origin + "/*"];
    if (!route) throw new Error(`unexpected request ${url}`);
    return typeof route === "function" ? route(u, init) : route;
  };
}

async function universeFile(dir, { collectedAt = "2026-10-26T07:00:00Z", symbols = ["005930", "000660"] } = {}) {
  const path = join(dir, "kospi-universe.json");
  const record = buildUniverseRecord({ method: "candidate_verification", symbols: symbols.map(symbol => ({ symbol, name: symbol })), collectedAt, candidateSource: "test" });
  await writeFile(path, JSON.stringify(record));
  return path;
}

test("robots 404 is allowed only when opted in; other unavailable statuses stay fail-closed", async () => {
  const ctx = () => ({ fetchImpl: async () => text("{}", 404, "application/json"), now: () => time });
  const target = "https://polling.finance.naver.com/api/realtime/domestic/stock/005930";
  assert.equal((await checkRobotsUrl(ctx(), target, UA)).ok, false);
  const allowed = await checkRobotsUrl(ctx(), target, UA, { allowMissing: true });
  assert.equal(allowed.ok, true); assert.equal(allowed.missing, true); assert.equal(allowed.robotsStatus, 404); assert.equal(allowed.checkedAt, time.toISOString());
  for (const status of [401, 403, 406, 429, 500, 503]) {
    const result = await checkRobotsUrl({ fetchImpl: async () => text("", status), now: () => time }, target, UA, { allowMissing: true });
    assert.equal(result.ok, false, `HTTP ${status}`); assert.match(result.reason, new RegExp(`HTTP ${status}`));
  }
  const network = await checkRobotsUrl({ fetchImpl: async () => { throw new TypeError("fetch failed"); }, now: () => time }, target, UA, { allowMissing: true });
  assert.equal(network.ok, false);
  const html = await checkRobotsUrl({ fetchImpl: async () => text("<html>", 200, "text/html"), now: () => time }, target, UA, { allowMissing: true });
  assert.equal(html.ok, false);
  assert.equal((await checkRobotsUrl({ fetchImpl: async () => text("", 404), now: () => time }, "http://api.stock.naver.com/x", UA, { allowMissing: true })).ok, false);
});

test("robots request keeps the project User-Agent and is fetched once per origin", async () => {
  const seen = [];
  const context = { fetchImpl: async (url, init) => { seen.push([url, init.headers["User-Agent"], init.headers.Accept, init.redirect]); return text("{}", 404, "application/json"); }, now: () => time };
  await checkRobotsUrl(context, "https://api.stock.naver.com/a", UA, { allowMissing: true });
  await checkRobotsUrl(context, "https://api.stock.naver.com/b", UA, { allowMissing: true });
  assert.deepEqual(seen, [["https://api.stock.naver.com/robots.txt", UA, "text/plain, */*;q=0.1", "error"]]);
});

test("disallowed Naver hosts stay blocked even with allowMissing", async () => {
  for (const target of ["https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=1", "https://finance.naver.com/sise/sise_market_sum.naver", "https://fchart.stock.naver.com/sise.nhn?symbol=005930"]) {
    const result = await checkRobotsUrl({ fetchImpl: async () => text(DISALLOW_ALL), now: () => time }, target, UA, { allowMissing: true });
    assert.equal(result.ok, false); assert.match(result.reason, /robots disallows/);
  }
});

test("universe list host is robots-checked before requests and a 404 robots allows the live list", async () => {
  const calls = [];
  const fetchImpl = hostFetch({
    "https://api.stock.naver.com/robots.txt": text("{}", 404, "application/json"),
    "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": json({ totalCount: 2, stocks: [{ symbolCode: "005930", stockName: "A", stockEndType: "stock", stockExchangeType: { code: "KS" } }, { symbolCode: "035720", stockName: "Q", stockEndType: "stock", stockExchangeType: { code: "KQ" } }] }),
  }, calls);
  const universe = await collectNaverUniverse({ fetchImpl, now: () => time, env: { KOSPI_UNIVERSE_CACHE: "missing.json" } });
  assert.equal(universe.ok, true); assert.equal(universe.universeSource, "live"); assert.deepEqual(universe.symbols.map(s => s.symbol), ["005930"]);
  assert.equal(calls[0], "https://api.stock.naver.com/robots.txt"); assert.ok(calls[1].startsWith(`${UNIVERSE_ENDPOINT}?page=1&pageSize=`));
  assert.equal(universe.robotsChecks["https://api.stock.naver.com"].robots_status, 404);
  assert.ok(calls.every(url => !url.includes("m.stock.naver.com")));
});

test("empty live list falls back to the committed list, records provenance, and tolerates delisted symbols", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-universe-"));
  try {
    const path = await universeFile(dir, { symbols: ["005930", "000660", "999990"] });
    const calls = [];
    const fetchImpl = hostFetch({
      "https://api.stock.naver.com/robots.txt": text("{}", 404, "application/json"),
      "https://polling.finance.naver.com/robots.txt": text("{}", 404, "application/json"),
      "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": json({ page: 1, totalCount: 0, stocks: [], marketStatus: "PREOPEN" }),
      "https://polling.finance.naver.com/api/realtime/domestic/stock/000660,005930,999990": json({ datas: [quote("005930"), quote("000660", { stockExchangeType: { code: "KQ" } })] }),
    }, calls);
    const provider = createNaverCrawlProvider({ env: { KOSPI_UNIVERSE_CACHE: path, KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "0" }, fetchImpl, now: () => time, runStartedAt: time.toISOString() });
    const result = await provider.generateForecast();
    assert.equal(result.status, "partial"); assert.deepEqual(result.rows.map(r => r.symbol), ["005930"]);
    const m = result.source.metrics;
    assert.equal(m.universe_source, "cache"); assert.equal(m.universe_endpoint, path); assert.equal(m.universe_stale, false); assert.equal(m.universe_as_of, "2026-10-26T07:00:00Z");
    assert.match(m.universe_fallback_reason, /empty \(marketStatus=PREOPEN\)/);
    assert.equal(m.excluded_missing_quotes, 1); assert.equal(m.excluded_non_kospi_quotes, 1);
    assert.equal(m.robots["https://polling.finance.naver.com"].robots_status, 404);
    assert.equal(result.source.license_status, "unconfirmed");
    assert.match(result.message, /committed list/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a stale committed list is used but marked partial and stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-universe-"));
  try {
    const path = await universeFile(dir, { collectedAt: "2026-10-01T00:00:00Z", symbols: ["005930"] });
    const cache = await loadKospiUniverseCache({ path, now: () => time });
    assert.equal(cache.ok, true); assert.equal(cache.stale, true);
    const fetchImpl = hostFetch({
      "https://api.stock.naver.com/robots.txt": text("{}", 404),
      "https://polling.finance.naver.com/robots.txt": text("{}", 404),
      "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": json({ totalCount: 0, stocks: [] }),
      "https://polling.finance.naver.com/api/realtime/domestic/stock/005930": json({ datas: [quote("005930")] }),
    });
    const result = await createNaverCrawlProvider({ env: { KOSPI_UNIVERSE_CACHE: path, KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0" }, fetchImpl, now: () => time, runStartedAt: time.toISOString() }).generateForecast();
    assert.equal(result.status, "partial"); assert.equal(result.source.metrics.universe_stale, true); assert.match(result.message, /\(stale\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("robots denial of the list host falls back to the committed list without requesting the list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-universe-"));
  try {
    const path = await universeFile(dir, { symbols: ["005930"] });
    const calls = [];
    const fetchImpl = hostFetch({
      "https://api.stock.naver.com/robots.txt": text(DISALLOW_ALL),
      "https://polling.finance.naver.com/robots.txt": text("{}", 404),
      "https://polling.finance.naver.com/api/realtime/domestic/stock/005930": json({ datas: [quote("005930")] }),
    }, calls);
    const universe = await collectNaverUniverse({ fetchImpl, now: () => time, env: { KOSPI_UNIVERSE_CACHE: path } });
    assert.equal(universe.ok, true); assert.equal(universe.universeSource, "cache"); assert.match(universe.universeFallbackReason, /robots disallows/);
    assert.ok(calls.every(url => !url.includes("marketValue")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("403 on the list host stops collection: no cache fallback and no quote request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-universe-"));
  try {
    const path = await universeFile(dir);
    const calls = [];
    const fetchImpl = hostFetch({ "https://api.stock.naver.com/robots.txt": text("{}", 404), "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": text("Forbidden", 403) }, calls);
    const result = await createNaverCrawlProvider({ env: { KOSPI_UNIVERSE_CACHE: path, KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0", KOSPI_CRAWL_MAX_RETRIES: "2" }, fetchImpl, now: () => time, runStartedAt: time.toISOString() }).generateForecast();
    assert.equal(result.status, "blocked"); assert.equal(calls.filter(u => u.includes("marketValue")).length, 1); assert.ok(calls.every(u => !u.includes("polling.finance")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("robots denial on the quote host blocks the run without any quote request", async () => {
  const calls = [];
  const fetchImpl = hostFetch({
    "https://api.stock.naver.com/robots.txt": text("{}", 404),
    "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": json({ totalCount: 1, stocks: [{ itemCode: "005930", stockName: "A" }] }),
    "https://polling.finance.naver.com/robots.txt": text(DISALLOW_ALL),
  }, calls);
  const result = await createNaverCrawlProvider({ env: { KOSPI_UNIVERSE_CACHE: "missing.json", KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0" }, fetchImpl, now: () => time, runStartedAt: time.toISOString() }).generateForecast();
  assert.equal(result.status, "blocked"); assert.match(result.message, /robots disallows \/api\/realtime\/domestic\/stock\/005930/);
  assert.ok(calls.every(u => !u.startsWith(QUOTE_ENDPOINT)));
});

test("empty live list without a usable committed list remains no_data", async () => {
  const fetchImpl = hostFetch({ "https://api.stock.naver.com/robots.txt": text("{}", 404), "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": json({ totalCount: 0, stocks: [] }) });
  const result = await createNaverCrawlProvider({ env: { KOSPI_UNIVERSE_CACHE: "missing.json", KOSPI_CRAWL_REQUEST_INTERVAL_MS: "0" }, fetchImpl, now: () => time, runStartedAt: time.toISOString() }).generateForecast();
  assert.equal(result.status, "no_data"); assert.match(result.message, /file not found/); assert.equal(result.rows.length, 0);
});

test("committed list validation rejects malformed, duplicated, future-dated and relicensed records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-universe-"));
  try {
    const base = buildUniverseRecord({ method: "candidate_verification", symbols: [{ symbol: "005930", name: "A" }], collectedAt: "2026-10-26T07:00:00Z" });
    for (const [mutate, reason] of [
      [r => { r.symbols.push({ symbol: "005930", name: "A" }); r.count = 2; }, /duplicate/],
      [r => { r.symbols[0].symbol = "0059/0"; }, /entry invalid/],
      [r => { r.license_status = "confirmed"; }, /license_status/],
      [r => { r.collected_at = "2026-11-30T00:00:00Z"; }, /future/],
      [r => { r.count = 5; }, /count mismatch/],
      [r => { r.market = "KOSDAQ"; }, /identity/],
    ]) {
      const record = structuredClone(base); mutate(record);
      const path = join(dir, "u.json"); await writeFile(path, JSON.stringify(record));
      const result = await loadKospiUniverseCache({ path, now: () => time });
      assert.equal(result.ok, false); assert.match(result.reason, reason);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("universe refresh verifies candidates on the quote host, supports dry-run and refuses large shrinkage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-universe-"));
  try {
    const candidates = join(dir, "candidates.json"), output = join(dir, "out.json");
    await writeFile(candidates, JSON.stringify({ rows: [{ symbol: "005930" }, { symbol: "000660" }, { symbol: "bad" }] }));
    assert.deepEqual(candidateSymbols(JSON.parse(await readFile(candidates, "utf8"))), ["005930", "000660"]);
    const routes = (datas) => hostFetch({
      "https://api.stock.naver.com/robots.txt": text("{}", 404),
      "https://polling.finance.naver.com/robots.txt": text("{}", 404),
      "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": json({ totalCount: 0, stocks: [] }),
      "https://polling.finance.naver.com/api/realtime/domestic/stock/005930,000660": json({ datas }),
    });
    const dry = await updateUniverse({ dryRun: true, candidatesPath: candidates, candidateLabel: { path: "candidates.json", as_of: "2026-10-26" }, outputPath: output, fetchImpl: routes([quote("005930"), quote("000660")]), now: () => time });
    assert.equal(dry.status, "dry_run"); assert.equal(dry.written, false); assert.equal(dry.verified, 2);
    await assert.rejects(readFile(output, "utf8"), { code: "ENOENT" });
    const shrink = await updateUniverse({ candidatesPath: candidates, candidateLabel: { path: "candidates.json", as_of: "2026-10-26" }, outputPath: output, fetchImpl: routes([quote("005930")]), now: () => time });
    assert.equal(shrink.status, "degraded"); assert.equal(shrink.written, false);
    const written = await updateUniverse({ candidatesPath: candidates, candidateLabel: { path: "candidates.json", as_of: "2026-10-26" }, outputPath: output, fetchImpl: routes([quote("005930"), quote("000660")]), now: () => time });
    assert.equal(written.status, "updated");
    const record = JSON.parse(await readFile(output, "utf8"));
    assert.equal(record.source.method, "candidate_verification"); assert.equal(record.discovers_new_listings, false); assert.equal(record.license_status, "unconfirmed"); assert.equal(record.count, 2);
    assert.equal(record.source.robots["https://polling.finance.naver.com"].robots_status, 404);
    const blocked = await updateUniverse({ candidatesPath: candidates, candidateLabel: { path: "candidates.json", as_of: "2026-10-26" }, outputPath: output, fetchImpl: hostFetch({ "https://api.stock.naver.com/robots.txt": text("{}", 404), "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": text("", 429) }), now: () => time });
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.written, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const CSV_URL = "https://aikstockdata.com/data/public/daily/quotes_20261026.csv";
const csvBody = (basDt = "20261026") => `basDt,종목코드,종목명,mrktCtg
${basDt},005930,삼성전자,KOSPI
${basDt},000660,SK하이닉스,KOSPI
${basDt},035720,카카오,KOSDAQ
`;
const AIK_ROBOTS = "User-agent: *\nAllow: /data/public/\nDisallow: /data/\n";

test("CSV candidates come from mrktCtg=KOSPI rows after an explicit robots allow, with provenance", async () => {
  const calls = [];
  const fetchImpl = hostFetch({ "https://aikstockdata.com/robots.txt": text(AIK_ROBOTS), "https://aikstockdata.com/data/public/daily/quotes_20261026.csv": text(csvBody(), 200, "text/csv") }, calls);
  const result = await fetchCsvCandidates({ date: "2026-10-26", fetchImpl, now: () => time });
  assert.equal(result.ok, true); assert.deepEqual(result.symbols, ["005930", "000660"]);
  assert.equal(result.label.url, CSV_URL); assert.equal(result.label.basDt, "2026-10-26"); assert.equal(result.label.kospi_rows, 2); assert.equal(result.label.robots_url, "https://aikstockdata.com/robots.txt");
  assert.deepEqual(calls, ["https://aikstockdata.com/robots.txt", CSV_URL]);
  const mismatch = await fetchCsvCandidates({ date: "2026-10-26", fetchImpl: hostFetch({ "https://aikstockdata.com/robots.txt": text(AIK_ROBOTS), "https://aikstockdata.com/data/public/daily/quotes_20261026.csv": text(csvBody("20261023"), 200, "text/csv") }), now: () => time });
  assert.equal(mismatch.ok, false); assert.match(mismatch.reason, /basDt/);
});

test("CSV candidate host is fail-closed: robots 404 or denial sends no CSV request", async () => {
  for (const robots of [text("", 404), text("User-agent: *\nDisallow: /\n")]) {
    const calls = [];
    const result = await fetchCsvCandidates({ date: "2026-10-26", fetchImpl: hostFetch({ "https://aikstockdata.com/robots.txt": robots }, calls), now: () => time });
    assert.equal(result.ok, false); assert.equal(result.blocked, true); assert.ok(calls.every(u => u !== CSV_URL));
  }
});

test("operational snapshots listed via a robots-disallowed host are refused as candidates", async () => {
  for (const path of ["data/latest-snapshot.json", "C:\\repo\\data\\latest-snapshot.json", "data/runs/2026-10-28/0900.json"]) assert.equal(isRefusedCandidatePath(path), true, path);
  for (const path of ["data/kospi-universe.json", "data/runs/historical-test/2026-10-23/1530.json"]) assert.equal(isRefusedCandidatePath(path), false, path);
  const fetchImpl = hostFetch({ "https://api.stock.naver.com/robots.txt": text("{}", 404), "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": json({ totalCount: 0, stocks: [] }) });
  const refused = await updateUniverse({ dryRun: true, candidatesPath: "data/latest-snapshot.json", fetchImpl, now: () => time });
  assert.equal(refused.status, "failed"); assert.match(refused.reason, /refused/);
});

test("universe refresh from CSV records the CSV source and verifies on the quote host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kospi-universe-"));
  try {
    const output = join(dir, "out.json");
    const fetchImpl = hostFetch({
      "https://api.stock.naver.com/robots.txt": text("{}", 404),
      "https://api.stock.naver.com/stock/exchange/KOSPI/marketValue": json({ totalCount: 0, stocks: [] }),
      "https://aikstockdata.com/robots.txt": text(AIK_ROBOTS),
      "https://aikstockdata.com/data/public/daily/quotes_20261026.csv": text(csvBody(), 200, "text/csv"),
      "https://polling.finance.naver.com/robots.txt": text("{}", 404),
      "https://polling.finance.naver.com/api/realtime/domestic/stock/005930,000660": json({ datas: [quote("005930"), quote("000660")] }),
    });
    const result = await updateUniverse({ candidatesCsvDate: "2026-10-26", outputPath: output, fetchImpl, now: () => time });
    assert.equal(result.status, "updated");
    const record = JSON.parse(await readFile(output, "utf8"));
    assert.equal(record.candidate_source.url, CSV_URL); assert.equal(record.candidate_source.basDt, "2026-10-26"); assert.equal(record.count, 2);
    assert.ok(!JSON.stringify(record).includes("m.stock.naver.com"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
