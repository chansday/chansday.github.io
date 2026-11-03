// Backfills daily investor flows (data/investor-flow/YYYY-MM-DD.json) as far
// back as the existing collector endpoint serves them.
// - Endpoint, User-Agent, 1 s pacing and 429/403 handling are those of the
//   owner's collector (scripts/collect-investor-flow.mjs). The endpoint pages
//   60 sessions per request (pageSize > 60 is HTTP 400) and `bizdate=YYYYMMDD`
//   returns the sessions strictly before that date.
// - Rounds are date-major: one request per symbol moves every symbol 60
//   sessions further back, then the round's dates are saved (and committed
//   with --commit), so every saved date covers the whole universe.
// - A new round starts only while the time budget can fit one; a symbol stops
//   once the source returns no older row. Re-running continues from the oldest
//   saved date.
// Usage: node scripts/backfill-investor-flow.mjs [--before YYYY-MM-DD] [--budget-minutes 330] [--max-rounds N] [--commit]
import { readFile, readdir, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isKoreanSymbol } from "../providers/korean-symbol.js";
import { createProgressLog, formatDuration } from "../providers/progress-log.js";
import { parseInvestorFlow } from "../providers/investor-flow.js";
import { kstDate, isValidDate } from "./market-calendar.mjs";
import { saveInvestorDays } from "./collect-investor-flow.mjs";

export const TREND_BASE = "https://m.stock.naver.com/api/stock/";
export const USER_AGENT = "kospi-signal-personal-investor-collector/1.0";
export const PAGE_SIZE = 60;
const compact = (iso) => iso.replaceAll("-", "");

export function trendPageUrl(symbol, before) {
  if (!isKoreanSymbol(symbol) || !isValidDate(before)) throw new Error("Invalid trend page request");
  return `${TREND_BASE}${symbol}/trend?pageSize=${PAGE_SIZE}&bizdate=${compact(before)}`;
}

export async function oldestSavedDate(directory = "data/investor-flow") {
  try { return (await readdir(directory)).map((f) => f.replace(/\.json$/, "")).filter(isValidDate).sort()[0] || null; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function backfillInvestorFlow(symbols, {
  before, budgetMs = 330 * 60_000, maxRounds = Infinity, delayMs = 1000, directory = "data/investor-flow",
  fetchImpl = globalThis.fetch, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = createProgressLog({ label: "매매동향 과거 수집", now }), afterRound = async () => {},
} = {}) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.some((s) => !isKoreanSymbol(s)) || new Set(symbols).size !== symbols.length) throw new Error("Invalid or duplicate stock codes");
  if (!isValidDate(before)) throw new Error("Invalid --before date");
  if (delayMs < 1000) throw new Error("Request interval must be at least one second");
  const asOfDate = kstDate(now()), startedAt = now().getTime();
  const cursor = new Map(symbols.map((s) => [s, before]));
  const summary = { before, rounds: [], requests: 0, stopped: null, oldest_date: null };
  let roundMs = symbols.length * (delayMs + 300);
  log(`시작 · ${before} 이전부터 · ${symbols.length}종목 · 한 번에 ${PAGE_SIZE}거래일 · 예산 ${formatDuration(budgetMs)}`);
  for (let round = 1; round <= maxRounds && cursor.size; round++) {
    const elapsed = now().getTime() - startedAt;
    if (elapsed + roundMs > budgetMs) { summary.stopped = "time_budget"; log(`시간 예산 안에 다음 바퀴(약 ${formatDuration(roundMs)})를 끝낼 수 없어 중단`); break; }
    const roundStart = now().getTime(), stocks = [];
    let failure = null;
    log(`바퀴 ${round} 시작 · 남은 종목 ${cursor.size}`);
    let i = 0;
    for (const [symbol, from] of [...cursor]) {
      if (summary.requests++) await sleep(delayMs);
      const url = trendPageUrl(symbol, from);
      const request = () => fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Language": "ko-KR,ko;q=0.9" }, redirect: "error", signal: AbortSignal.timeout(12000) });
      try {
        let response = await request();
        if (response.status === 429) {
          const header = response.headers.get("retry-after"), seconds = header && /^\d+$/.test(header) ? Number(header) : 60;
          if (seconds > 120) { failure = { symbol, reason: "HTTP_429" }; break; }
          log(`HTTP 429 · ${symbol} · ${Math.max(seconds, 1)}초 대기 후 1회 재시도`);
          await sleep(Math.max(seconds, 1) * 1000); response = await request(); summary.requests++;
        }
        if (!response.ok) { failure = { symbol, reason: `HTTP_${response.status}` }; break; }
        if (!/json/i.test(response.headers.get("content-type") || "")) { failure = { symbol, reason: "unexpected_content_type" }; break; }
        const text = await response.text();
        if (text.length > 2_000_000) { failure = { symbol, reason: "response_too_large" }; break; }
        const { rows } = parseInvestorFlow(JSON.parse(text), symbol, "1990-01-01", asOfDate, asOfDate);
        const older = rows.filter((r) => r.date < from);
        if (!older.length) cursor.delete(symbol);
        else { stocks.push({ symbol, rows: older }); cursor.set(symbol, older.at(-1).date); }
      } catch (error) { failure = { symbol, reason: error.name === "TimeoutError" ? "timeout" : "request_or_response_error" }; break; }
      if (++i % 100 === 0) log(`바퀴 ${round} 진행 ${i}/${symbols.length}`);
    }
    // Save only a complete round so every saved date covers all symbols.
    if (failure) { summary.stopped = failure; log(`중단 · ${failure.symbol} · ${failure.reason} · 이 바퀴는 저장하지 않음`); break; }
    const dates = stocks.flatMap((s) => s.rows.map((r) => r.date)).sort();
    await saveInvestorDays({ stocks }, directory);
    roundMs = Math.max(roundMs, now().getTime() - roundStart);
    const record = { round, symbols: stocks.length, first_date: dates[0] || null, last_date: dates.at(-1) || null, duration_ms: now().getTime() - roundStart };
    summary.rounds.push(record);
    if (dates[0]) summary.oldest_date = dates[0];
    log(`바퀴 ${round} 저장 · ${record.symbols}종목 · ${record.first_date}~${record.last_date} · ${formatDuration(record.duration_ms)}`);
    await afterRound(record);
  }
  if (!summary.stopped) summary.stopped = cursor.size ? "max_rounds" : "source_exhausted";
  log(`종료 · ${summary.rounds.length}바퀴 · 가장 오래된 날짜 ${summary.oldest_date ?? "-"} · 사유 ${typeof summary.stopped === "string" ? summary.stopped : summary.stopped.reason}`);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  let before = null, budgetMinutes = 330, maxRounds = Infinity, commit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--before") before = argv[++i] || null;
    else if (a === "--budget-minutes") budgetMinutes = Number(argv[++i]);
    else if (a === "--max-rounds") maxRounds = Number(argv[++i]);
    else if (a === "--commit") commit = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  before ||= (await oldestSavedDate()) || kstDate();
  if (!(budgetMinutes > 0) || !(maxRounds > 0)) throw new Error("Invalid budget or round limit");
  const universe = JSON.parse(await readFile("data/kospi-universe.json", "utf8"));
  const symbols = universe.symbols.map((x) => x.symbol);
  const afterRound = commit ? async (r) => {
    execFileSync("git", ["add", "--", "data/investor-flow"], { stdio: "inherit" });
    try { execFileSync("git", ["diff", "--cached", "--quiet"]); return; } catch { /* staged changes */ }
    execFileSync("bash", ["scripts/commit-and-push.sh", `chore(data): backfill investor flow ${r.first_date}~${r.last_date}`], { stdio: "inherit" });
  } : undefined;
  const summary = await backfillInvestorFlow(symbols, { before, budgetMs: budgetMinutes * 60_000, maxRounds, afterRound });
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ["### 매매동향 과거 수집", `- 시작 기준: ${summary.before} 이전`, `- 저장한 바퀴: ${summary.rounds.length} · 가장 오래된 날짜: ${summary.oldest_date ?? "-"}`, `- 종료 사유: ${typeof summary.stopped === "string" ? summary.stopped : `${summary.stopped.symbol} ${summary.stopped.reason}`}`, `- 요청 수: ${summary.requests}`, "", "| 바퀴 | 종목 | 기간 | 소요 |", "| --- | --- | --- | --- |", ...summary.rounds.map((r) => `| ${r.round} | ${r.symbols} | ${r.first_date}~${r.last_date} | ${formatDuration(r.duration_ms)} |`)];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  if (typeof summary.stopped === "object") process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
