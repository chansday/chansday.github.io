// Read-only probe for a robots-permitted source of per-stock investor trading
// flows (foreign / institution / individual net buying) and how far back it
// goes. Nothing is written to the repository; the report goes to stdout and
// the GitHub step summary.
// - Every data request is checked against the origin's robots.txt first
//   (checkRobotsUrl, 404/410 = no rules). A denied or unreadable policy skips
//   the request.
// - m.stock.naver.com is only re-checked for its robots.txt (documented as
//   "Disallow: /" on 2026-10-28); no data request is sent there.
// - Requests are sequential, at least 1 s apart, and capped (MAX_REQUESTS).
// Usage: node scripts/probe-investor-sources.mjs [--symbol 005930]
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { checkRobotsUrl, robotsAllowsPath } from "../providers/robots-policy.js";
import { isKoreanSymbol } from "../providers/korean-symbol.js";

export const USER_AGENT = "kospi-signal-board/1.0 (+https://kospi-signal.github.io/)";
export const MAX_REQUESTS = 40;
const DATE_KEYS = ["bizdate", "localDate", "localTradedAt", "tradeDate", "date", "dt"];
const INVESTOR_KEY = /PureBuy|foreigner(?!Hold)|organ|individual|institution|investor/i;

// Candidate endpoints on hosts whose robots.txt is documented as absent (404).
export function candidateUrls(symbol) {
  const api = "https://api.stock.naver.com", polling = "https://polling.finance.naver.com";
  return [
    `${api}/stock/${symbol}/trend`,
    `${api}/stock/${symbol}/investorTrend`,
    `${api}/stock/${symbol}/investor`,
    `${api}/stock/${symbol}/dealTrend`,
    `${api}/stock/${symbol}/integration`,
    `${api}/stock/${symbol}/basic`,
    `${api}/chart/domestic/item/${symbol}/day?startDateTime=202401010000&endDateTime=202611022359`,
    `${polling}/api/realtime/domestic/stock/${symbol}`,
  ];
}

const compactToIso = (v) => {
  const s = String(v ?? "");
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

// Finds arrays of objects anywhere in a JSON payload and describes them by
// key names, row count, date range and investor-like fields (no values).
export function describePayload(payload) {
  const tables = [];
  const walk = (node, path, depth) => {
    if (depth > 4 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      const objects = node.filter((x) => x && typeof x === "object" && !Array.isArray(x));
      if (objects.length) {
        const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))];
        const dateKey = DATE_KEYS.find((k) => keys.includes(k));
        const dates = dateKey ? objects.map((o) => compactToIso(o[dateKey])).filter(Boolean).sort() : [];
        tables.push({ path: path || "$", rows: objects.length, keys: keys.slice(0, 40), date_key: dateKey || null, first_date: dates[0] || null, last_date: dates.at(-1) || null, investor_keys: keys.filter((k) => INVESTOR_KEY.test(k)) });
      }
      objects.slice(0, 1).forEach((o) => walk(o, `${path}[0]`, depth + 1));
      return;
    }
    const keys = Object.keys(node);
    const investorKeys = keys.filter((k) => INVESTOR_KEY.test(k));
    if (!path || investorKeys.length) tables.push({ path: path || "$", rows: null, keys: keys.slice(0, 40), date_key: null, first_date: null, last_date: null, investor_keys: investorKeys });
    for (const k of keys) walk(node[k], path ? `${path}.${k}` : k, depth + 1);
  };
  walk(payload, "", 0);
  return tables;
}

// The owner's existing collector endpoint (scripts/collect-investor-flow.mjs).
// The owner chose to use it regardless of its robots.txt, so it is requested
// directly with the collector's User-Agent, at the same 1 s pace.
export const COLLECTOR_TREND = (symbol) => `https://m.stock.naver.com/api/stock/${symbol}/trend`;
export const COLLECTOR_USER_AGENT = "kospi-signal-personal-investor-collector/1.0";

export async function probe({ symbol = "005930", collectorEndpoint = false, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), log = console.log } = {}) {
  if (!isKoreanSymbol(symbol)) throw new Error("Invalid symbol");
  const context = { fetchImpl, now }, report = { symbol, started_at: now().toISOString(), robots: [], requests: [], best: null, depth: null };
  let count = 0;
  const get = async (url) => {
    if (count >= MAX_REQUESTS) return { url, skipped: "request_cap" };
    if (!collectorEndpoint) {
      const policy = await checkRobotsUrl(context, url, USER_AGENT, { allowMissing: true });
      if (!policy.ok) return { url, skipped: `robots: ${policy.reason}` };
    }
    if (count++) await sleep(1000);
    try {
      const r = await fetchImpl(url, { headers: { "User-Agent": collectorEndpoint ? COLLECTOR_USER_AGENT : USER_AGENT, Accept: "application/json", "Accept-Language": "ko-KR,ko;q=0.9" }, redirect: "error", signal: AbortSignal.timeout(12000) });
      const type = r.headers.get("content-type") || "";
      const out = { url, status: r.status, content_type: type };
      if (r.ok && /json/i.test(type)) { const text = await r.text(); if (text.length <= 5_000_000) { out.payload = JSON.parse(text); out.tables = describePayload(out.payload); } }
      return out;
    } catch (error) { return { url, error: error.name || "error" }; }
  };

  if (collectorEndpoint) {
    const url = COLLECTOR_TREND(symbol), r = await get(url), tables = r.tables || [];
    report.requests.push({ url, status: r.status ?? null, skipped: null, error: r.error || null, content_type: r.content_type || null, tables });
    log(`${url} · ${r.error || `HTTP ${r.status}`} · ${tables.map((t) => `${t.rows ?? "obj"}행 ${t.first_date ?? ""}~${t.last_date ?? ""}`).join("; ")}`);
    const hit = tables.find((t) => t.rows && t.date_key && t.investor_keys.length);
    if (hit) report.best = { url, table: hit };
  }
  // 1) Re-read robots.txt of the documented hosts (no data request to m.stock).
  for (const origin of collectorEndpoint ? [] : ["https://m.stock.naver.com", "https://api.stock.naver.com", "https://polling.finance.naver.com"]) {
    const path = `/api/stock/${symbol}/trend`;
    const policy = await checkRobotsUrl(context, `${origin}${path}`, USER_AGENT, { allowMissing: true });
    const cached = await context.robotsCache.get(origin);
    report.robots.push({ origin, ok: policy.ok, reason: policy.reason || null, missing: Boolean(cached?.missing), status: cached?.status ?? null, sample_path_allowed: cached?.ok ? (cached.missing ? true : robotsAllowsPath(cached.text, path, USER_AGENT)) : false, text_head: cached?.text ? cached.text.slice(0, 400) : null });
    log(`robots ${origin} · ${policy.ok ? "허용" : `금지/확인 불가 (${policy.reason})`}`);
  }

  // 2) Candidate endpoints on permitted hosts.
  for (const url of collectorEndpoint ? [] : candidateUrls(symbol)) {
    const r = await get(url);
    const tables = r.tables || [];
    report.requests.push({ url: r.url, status: r.status ?? null, skipped: r.skipped || null, error: r.error || null, content_type: r.content_type || null, tables });
    log(`${url} · ${r.skipped || r.error || `HTTP ${r.status}`}${tables.length ? ` · 표 ${tables.map((t) => `${t.path}(${t.rows ?? "obj"}행${t.investor_keys.length ? `, 수급 ${t.investor_keys.join("/")}` : ""}${t.first_date ? `, ${t.first_date}~${t.last_date}` : ""})`).join("; ")}` : ""}`);
    const hit = tables.find((t) => t.rows && t.date_key && t.investor_keys.length);
    if (hit && !report.best) report.best = { url, table: hit };
  }

  // 3) Depth of the best per-date investor table: paging parameters.
  if (report.best) {
    const base = report.best.url.split("?")[0];
    const variants = [];
    for (const size of [20, 60, 100, 200, 500]) variants.push(`${base}?pageSize=${size}`);
    const results = [];
    for (const url of variants) {
      const r = await get(url), t = (r.tables || []).find((x) => x.date_key && x.investor_keys.length);
      results.push({ url, status: r.status ?? null, rows: t?.rows ?? null, first_date: t?.first_date ?? null, last_date: t?.last_date ?? null });
      log(`페이지 크기 ${url} · ${t ? `${t.rows}행 ${t.first_date}~${t.last_date}` : r.skipped || r.error || `HTTP ${r.status}`}`);
    }
    const best = results.filter((x) => x.rows).sort((a, b) => b.rows - a.rows)[0];
    const pageSize = best && best.rows > (report.best.table.rows || 0) ? Number(new URL(best.url).searchParams.get("pageSize")) : null;
    // Walk older pages with bizdate (the oldest date seen) until no older rows.
    let oldest = (best?.first_date) || report.best.table.first_date, pages = [];
    for (let i = 0; i < 20 && oldest; i++) {
      const params = new URLSearchParams({ ...(pageSize ? { pageSize: String(pageSize) } : {}), bizdate: oldest.replaceAll("-", "") });
      const r = await get(`${base}?${params}`), t = (r.tables || []).find((x) => x.date_key && x.investor_keys.length);
      pages.push({ bizdate: oldest, status: r.status ?? null, rows: t?.rows ?? null, first_date: t?.first_date ?? null, last_date: t?.last_date ?? null, skipped: r.skipped || null });
      log(`과거 페이지 bizdate=${oldest} · ${t ? `${t.rows}행 ${t.first_date}~${t.last_date}` : r.skipped || r.error || `HTTP ${r.status}`}`);
      if (!t || !t.first_date || t.first_date >= oldest) break;
      oldest = t.first_date;
    }
    report.depth = { page_size_results: results, page_size: pageSize, bizdate_pages: pages, oldest_date: [report.best.table.first_date, best?.first_date, ...pages.map((p) => p.first_date)].filter(Boolean).sort()[0] || null };
  }
  report.requests_sent = count;
  report.completed_at = now().toISOString();
  return report;
}

function summaryMarkdown(report) {
  const lines = ["### 매매동향 출처 점검", "", `- 종목: \`${report.symbol}\` · 데이터 요청 ${report.requests_sent}건`, "", "| robots.txt | 결과 |", "| --- | --- |"];
  for (const r of report.robots) lines.push(`| ${r.origin} | ${r.ok ? (r.missing ? `허용 (robots ${r.status})` : "허용") : `금지/확인 불가 · ${r.reason}`} |`);
  lines.push("", "| 주소 | 결과 | 수급 필드 | 날짜 범위 |", "| --- | --- | --- | --- |");
  for (const q of report.requests) {
    const t = (q.tables || []).find((x) => x.investor_keys.length) || (q.tables || [])[0];
    lines.push(`| \`${q.url.replace(/^https:\/\//, "")}\` | ${q.skipped || q.error || `HTTP ${q.status}`} | ${t?.investor_keys.join(", ") || "-"} | ${t?.first_date ? `${t.first_date}~${t.last_date} (${t.rows}행)` : "-"} |`);
  }
  lines.push("", report.best ? `**결론:** \`${report.best.url}\`에 날짜별 수급이 있음. 확인된 가장 오래된 날짜: **${report.depth?.oldest_date ?? report.best.table.first_date}**` : "**결론:** robots가 허용하는 주소에서 날짜별 수급 표를 찾지 못함.");
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2), i = args.indexOf("--symbol"), symbol = i >= 0 ? args[i + 1] : "005930";
  const report = await probe({ symbol, collectorEndpoint: args.includes("--collector-endpoint"), log: (m) => console.log(`[수급 출처 점검 ${new Date().toISOString()}] ${m}`) });
  for (const q of report.requests) delete q.payload;
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(report));
}
