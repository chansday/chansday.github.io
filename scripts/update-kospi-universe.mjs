import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fetchLiveKospiUniverse, verifyKospiSymbols, QUOTE_ENDPOINT, UNIVERSE_ENDPOINT } from "../providers/naver-crawl-provider.js";
import { KOSPI_UNIVERSE_PATH, validateUniverseRecord } from "../providers/kospi-universe-cache.js";
import { isKoreanSymbol } from "../providers/korean-symbol.js";
import { checkRobotsUrl } from "../providers/robots-policy.js";
import { parseCsv } from "../providers/public-csv-provider.js";
import { classifyMarketDate, isValidDate, kstDate, loadMarketCalendar } from "./market-calendar.mjs";
import { displayPath, repoPath } from "../providers/repo-paths.js";

// Refreshes data/kospi-universe.json from robots-permitted hosts only.
// 1. api.stock.naver.com KOSPI list (live_list) when it returns rows.
// 2. Otherwise candidate symbols are re-confirmed on polling.finance.naver.com
//    (stockExchangeType.code === "KS"). Candidates come from, in order:
//    --candidates-csv YYYY-MM-DD (aikstockdata public daily CSV, mrktCtg=KOSPI,
//    source: 금융위원회 공공데이터포털·한국거래소), an explicit --candidates file,
//    or the existing committed list. Candidates never come from a host whose
//    robots.txt disallows this agent; operational snapshots (data/latest-snapshot.json,
//    data/runs/YYYY-MM-DD) were listed via m.stock.naver.com and are refused.
//    This mode cannot discover new listings and records that in the file.
// A 403/429/challenge stops the refresh; nothing is retried or substituted.
export const MIN_RETAINED_RATIO = 0.9;
export const CSV_SOURCE_ROOT = "https://aikstockdata.com/data/public/daily";
export const CSV_LICENSE_URL = "https://aikstockdata.com/licenses/aiksd-public-1.1.txt";
const USER_AGENT = "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)";

export function isRefusedCandidatePath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  return /(^|\/)latest-snapshot\.json$/.test(normalized) || /(^|\/)data\/runs\/\d{4}-\d{2}-\d{2}\//.test(normalized);
}

// Fetches one public daily CSV after an explicit robots allow (fail-closed: a
// missing or unavailable robots.txt is not accepted for this host). No retry.
export async function fetchCsvCandidates({ date, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  if (!isValidDate(date)) throw new Error("invalid --candidates-csv date");
  const url = `${CSV_SOURCE_ROOT}/quotes_${date.replaceAll("-", "")}.csv`;
  const policy = await checkRobotsUrl({ fetchImpl, now }, url, USER_AGENT);
  if (!policy.ok) return { ok: false, blocked: true, reason: `robots: ${policy.reason}` };
  const response = await fetchImpl(url, { headers: { Accept: "text/csv", "User-Agent": USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(15000) });
  const type = response.headers?.get?.("content-type") || "";
  if (response.status === 403 || response.status === 429 || /text\/html/i.test(type)) return { ok: false, blocked: true, reason: `CSV HTTP ${response.status}` };
  if (response.status !== 200) return { ok: false, reason: `CSV HTTP ${response.status}` };
  const rows = parseCsv(await response.text()).filter(row => row.mrktCtg === "KOSPI");
  const basDt = date.replaceAll("-", "");
  if (!rows.length) return { ok: false, reason: "CSV has no mrktCtg=KOSPI rows" };
  if (rows.some(row => row.basDt !== basDt || !isKoreanSymbol(row["종목코드"]) || !String(row["종목명"] || "").trim())) return { ok: false, reason: "CSV KOSPI row has mismatched basDt or invalid code/name" };
  const symbols = [...new Set(rows.map(row => row["종목코드"]))];
  if (symbols.length !== rows.length) return { ok: false, reason: "CSV KOSPI rows contain duplicate codes" };
  return { ok: true, symbols, label: { url, basDt: date, filter: "mrktCtg=KOSPI", kospi_rows: rows.length, retrieved_at: now().toISOString(), robots_url: policy.robotsUrl, robots_checked_at: policy.checkedAt, origin: "금융위원회 공공데이터포털·한국거래소 (via aikstockdata public daily CSV)", license_url: CSV_LICENSE_URL } };
}

export function candidateSymbols(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.symbols) ? json.symbols : Array.isArray(json?.rows) ? json.rows : null;
  if (!list) throw new Error("candidate file has no symbols/rows array");
  const symbols = [...new Set(list.map(item => typeof item === "string" ? item : item?.symbol).filter(isKoreanSymbol))];
  if (!symbols.length) throw new Error("candidate file contains no valid symbols");
  return symbols;
}

// candidates_as_of: the data date the candidate set reflects (CSV basDt or the
// live-list time). collected_at: when that candidate set was obtained. Both are
// preserved when an existing list is only re-verified; verified_at records the
// latest polling confirmation. Staleness is judged from candidates_as_of.
export function buildUniverseRecord({ method, symbols, collectedAt, candidatesAsOf = collectedAt, verifiedAt = collectedAt, candidateSource = null, excluded = { missing: [], other: [] }, robotsChecks = {} }) {
  const record = {
    schema_version: 1,
    kind: "kospi_universe",
    market: "KOSPI",
    license_status: "unconfirmed",
    candidates_as_of: candidatesAsOf,
    collected_at: collectedAt,
    verified_at: verifiedAt,
    source: {
      method,
      url: method === "live_list" ? UNIVERSE_ENDPOINT : QUOTE_ENDPOINT,
      verification_field: method === "live_list" ? null : "stockExchangeType.code === \"KS\"",
      robots: robotsChecks,
    },
    candidate_source: candidateSource,
    discovers_new_listings: method === "live_list",
    excluded,
    count: symbols.length,
    symbols: [...symbols].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    notice: "Symbol list only; never used as a price source. Unofficial Naver endpoints; usage and redistribution terms unconfirmed. Candidate verification cannot add new listings.",
  };
  validateUniverseRecord(record);
  return record;
}

// Most recent trading dates strictly before `today` (KST), newest first.
export async function recentTradingDates(today, count = 3) {
  const calendar = await loadMarketCalendar();
  const result = [];
  for (let days = 1; days <= 20 && result.length < count; days++) {
    const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - days);
    const value = date.toISOString().slice(0, 10), state = classifyMarketDate(value, calendar);
    if (state.status === "error") break;
    if (state.status === "run") result.push(value);
  }
  return result;
}

async function readExisting(path) {
  try { const json = JSON.parse(await readFile(path, "utf8")); validateUniverseRecord(json); return json; }
  catch { return null; }
}

// "latest" tries at most 3 recent trading-day CSVs (newest first). A CSV not
// newer than the existing candidates_as_of is skipped. A blocked CSV request
// stops the refresh; otherwise, with no newer CSV, the existing list is re-verified.
async function pickCsvCandidates({ csvDate, existing, fetchImpl, now }) {
  const dates = csvDate === "latest" ? await recentTradingDates(kstDate(now())) : [csvDate];
  const attempts = [];
  for (const date of dates) {
    if (existing && typeof existing.candidates_as_of === "string" && date <= existing.candidates_as_of.slice(0, 10)) { attempts.push({ date, reason: "not newer than existing candidates_as_of" }); continue; }
    const csv = await fetchCsvCandidates({ date, fetchImpl, now });
    if (csv.ok) return { ok: true, csv, attempts };
    attempts.push({ date, reason: csv.reason });
    if (csv.blocked) return { ok: false, blocked: true, reason: csv.reason, attempts };
  }
  return { ok: false, reason: attempts.map(a => `${a.date}: ${a.reason}`).join("; ") || "no candidate CSV date", attempts };
}

export async function updateUniverse({ dryRun = false, candidatesCsvDate = null, candidatesPath = null, candidateLabel = null, outputPath = KOSPI_UNIVERSE_PATH, fetchImpl = globalThis.fetch, now = () => new Date(), env = {} } = {}) {
  const target = repoPath(outputPath);
  const live = await fetchLiveKospiUniverse({ fetchImpl, now, env });
  let record;
  if (live.ok) {
    const at = now().toISOString();
    record = buildUniverseRecord({ method: "live_list", symbols: live.symbols, collectedAt: at, candidatesAsOf: at, verifiedAt: at, robotsChecks: live.robotsChecks });
    if (dryRun) return { status: "dry_run", written: false, method: record.source.method, count: record.count, robots: live.robotsChecks };
    await writeAtomic(target, record);
    return { status: "updated", written: true, path: displayPath(outputPath), method: record.source.method, count: record.count };
  }
  if (live.blocked && !live.robots) return { status: "blocked", reason: `live list: ${live.reason}`, written: false };
  const existing = await readExisting(target);
  let candidates, provenance, csvAttempts = [];
  if (candidatesCsvDate) {
    const picked = await pickCsvCandidates({ csvDate: candidatesCsvDate, existing, fetchImpl, now });
    csvAttempts = picked.attempts;
    if (picked.ok) {
      const { csv } = picked;
      candidates = csv.symbols;
      provenance = { candidatesAsOf: csv.label.basDt, collectedAt: csv.label.retrieved_at, candidateSource: csv.label };
    } else if (picked.blocked || candidatesCsvDate !== "latest" || !existing) {
      return { status: picked.blocked ? "blocked" : "failed", reason: `live list unavailable (${live.reason}); CSV candidates unavailable: ${picked.reason}`, written: false, csv_attempts: csvAttempts };
    }
  }
  if (!candidates) {
    const path = candidatesPath ? repoPath(candidatesPath) : target;
    if (isRefusedCandidatePath(path)) return { status: "failed", reason: `candidate file ${displayPath(candidatesPath || outputPath)} was listed via a robots-disallowed host and is refused`, written: false };
    let json;
    try { json = JSON.parse(await readFile(path, "utf8")); candidates = candidateSymbols(json); }
    catch (error) { return { status: "failed", reason: `live list unavailable (${live.reason}); candidates unavailable: ${error.message}`, written: false, csv_attempts: csvAttempts }; }
    if (json?.kind === "kospi_universe") {
      try { validateUniverseRecord(json); } catch (error) { return { status: "failed", reason: `existing list invalid: ${error.message}`, written: false }; }
      // Re-verification keeps the original candidate provenance unchanged (no nesting).
      provenance = { candidatesAsOf: json.candidates_as_of, collectedAt: json.collected_at, candidateSource: json.candidate_source ?? null };
    } else {
      provenance = { candidatesAsOf: candidateLabel?.as_of || null, collectedAt: now().toISOString(), candidateSource: candidateLabel || displayPath(candidatesPath) };
      if (!provenance.candidatesAsOf) return { status: "failed", reason: "a non-universe candidate file needs an explicit as-of date (--candidates-as-of YYYY-MM-DD)", written: false };
    }
  }
  const verified = await verifyKospiSymbols(candidates, { fetchImpl, now, env });
  if (!verified.ok) return { status: verified.blocked ? "blocked" : "degraded", reason: `verification: ${verified.reason}`, written: false, live_reason: live.reason };
  const summary = { live_reason: live.reason, csv_attempts: csvAttempts, candidates_as_of: provenance.candidatesAsOf, candidates: candidates.length, verified: verified.verified.length, missing: verified.missing.length, other_exchange: verified.other.length, requested: verified.metrics.requested, robots: verified.robotsChecks };
  if (verified.verified.length / candidates.length < MIN_RETAINED_RATIO) return { status: "degraded", reason: `only ${verified.verified.length}/${candidates.length} candidates verified; list not replaced`, written: false, ...summary };
  record = buildUniverseRecord({ method: "candidate_verification", symbols: verified.verified, collectedAt: provenance.collectedAt, candidatesAsOf: provenance.candidatesAsOf, verifiedAt: now().toISOString(), candidateSource: provenance.candidateSource, excluded: { missing: verified.missing, other: verified.other }, robotsChecks: { ...live.robotsChecks, ...verified.robotsChecks } });
  if (dryRun) return { status: "dry_run", written: false, method: record.source.method, count: record.count, ...summary };
  await writeAtomic(target, record);
  return { status: "updated", written: true, path: displayPath(outputPath), method: record.source.method, count: record.count, ...summary };
}

async function writeAtomic(path, record) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    validateUniverseRecord(JSON.parse(await readFile(temp, "utf8")));
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] ?? null : null; };
  updateUniverse({ dryRun: args.includes("--dry-run"), candidatesCsvDate: value("--candidates-csv"), candidatesPath: value("--candidates"), candidateLabel: value("--candidates-as-of") ? { path: value("--candidates"), as_of: value("--candidates-as-of") } : null, outputPath: value("--output") || KOSPI_UNIVERSE_PATH })
    .then(result => { console.log(JSON.stringify(result, null, 2)); if (!["updated", "dry_run"].includes(result.status)) process.exitCode = 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
