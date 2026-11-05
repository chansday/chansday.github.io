// Backfills daily investor flows (data/investor-flow/YYYY-MM-DD.json) as far
// back as the existing collector endpoint serves them.
// - Endpoint, 1 s pacing and the retry / User-Agent policy
//   (providers/investor-request.js) are those of the daily collector. The endpoint pages
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
import { createInvestorRequester, formatRequestStats, INVESTOR_USER_AGENTS } from "../providers/investor-request.js";

export const TREND_BASE = process.env.INVESTOR_SECONDARY_ORIGIN || Buffer.from('aHR0cHM6Ly9tLnN0b2NrLm5hdmVyLmNvbS9hcGkvc3RvY2sv','base64').toString('utf8');
export const USER_AGENT = INVESTOR_USER_AGENTS[0];
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
  const request = createInvestorRequester({ fetchImpl, sleep, log });
  let roundMs = symbols.length * (delayMs + 300);
  log(`시작 · ${before} 이전부터 · ${symbols.length}종목 · 한 번에 ${PAGE_SIZE}거래일 · 요청 간격 ${delayMs}ms · 예산 ${formatDuration(budgetMs)} · 바퀴당 예상 ${formatDuration(roundMs)} · 보조 수집원 사용`);
  for (let round = 1; round <= maxRounds && cursor.size; round++) {
    const elapsed = now().getTime() - startedAt;
    if (elapsed + roundMs > budgetMs) { summary.stopped = "time_budget"; log(`시간 예산 안에 다음 바퀴(약 ${formatDuration(roundMs)})를 끝낼 수 없어 중단`); break; }
    const roundStart = now().getTime(), stocks = [];
    let failure = null;
    const roundSymbols = cursor.size, cursorDates = [...cursor.values()].sort();
    log(`바퀴 ${round} 시작 · 남은 종목 ${roundSymbols} · 기준 날짜 ${cursorDates[0]}~${cursorDates.at(-1)} 이전 · 누적 경과 ${formatDuration(elapsed)} / 예산 ${formatDuration(budgetMs)}`);
    let i = 0, rowCount = 0, ended = 0, oldest = null;
    const base = request.stats();
    for (const [symbol, from] of [...cursor]) {
      if (summary.requests) await sleep(delayMs);
      try {
        const result = await request(trendPageUrl(symbol, from), symbol);
        summary.requests += result.requests;
        if (result.error) throw result.error;
        const response = result.response;
        if (!response.ok) { failure = { symbol, from, reason: `HTTP_${response.status}` }; break; }
        if (!/json/i.test(response.headers.get("content-type") || "")) { failure = { symbol, from, reason: "unexpected_content_type", detail: response.headers.get("content-type") || "" }; break; }
        const text = await response.text();
        if (text.length > 2_000_000) { failure = { symbol, from, reason: "response_too_large", detail: `${text.length} bytes` }; break; }
        const { rows } = parseInvestorFlow(JSON.parse(text), symbol, "1990-01-01", asOfDate, asOfDate);
        const older = rows.filter((r) => r.date < from);
        if (!older.length) { cursor.delete(symbol); ended++; }
        else {
          stocks.push({ symbol, rows: older }); cursor.set(symbol, older.at(-1).date); rowCount += older.length;
          if (!oldest || older.at(-1).date < oldest) oldest = older.at(-1).date;
          if (older.length < PAGE_SIZE) { cursor.delete(symbol); ended++; log(`${symbol} · ${older.length}행(${older.at(-1).date}~${older[0].date}) · 페이지가 덜 차서 이 종목은 여기서 끝`); }
        }
      } catch (error) { failure = { symbol, from, reason: error.name === "TimeoutError" ? "timeout" : "request_or_response_error", detail: `${error.name}: ${String(error.message || "").slice(0, 120)}` }; break; }
      if (++i % 50 === 0 || i === roundSymbols) {
        const spent = now().getTime() - roundStart, st = request.stats();
        log(`바퀴 ${round} 진행 ${i}/${roundSymbols} (${Math.round(i * 100 / roundSymbols)}%) · 경과 ${formatDuration(spent)} · 남은 예상 ${formatDuration(spent / i * (roundSymbols - i))} · 행 ${rowCount} · 가장 오래된 ${oldest ?? "-"} · 끝난 종목 ${ended} · 요청 ${st.requests - base.requests} · UA 전환 ${st.ua_switches - base.ua_switches} · 재시도 ${st.rate_limit_waits + st.transient_retries - base.rate_limit_waits - base.transient_retries} · ${st.current_user_agent}`);
      }
    }
    // Save only a complete round so every saved date covers all symbols.
    if (failure) { summary.stopped = failure; log(`중단 · ${failure.symbol} (bizdate ${failure.from}) · ${failure.reason}${failure.detail ? ` · ${failure.detail}` : ""} · 바퀴 ${round}에서 받은 ${i}종목 ${rowCount}행은 저장하지 않음`); break; }
    const dates = stocks.flatMap((s) => s.rows.map((r) => r.date)).sort();
    await saveInvestorDays({ stocks }, directory);
    roundMs = Math.max(roundMs, now().getTime() - roundStart);
    const after = request.stats(), days = new Set(dates).size;
    const record = { round, symbols: stocks.length, ended, rows: rowCount, dates: days, first_date: dates[0] || null, last_date: dates.at(-1) || null, duration_ms: now().getTime() - roundStart, requests: after.requests - base.requests, ua_switches: after.ua_switches - base.ua_switches, retries: after.rate_limit_waits + after.transient_retries - base.rate_limit_waits - base.transient_retries };
    summary.rounds.push(record);
    if (dates[0]) summary.oldest_date = dates[0];
    log(`바퀴 ${round} 저장 · ${record.symbols}종목 · ${days}일(${record.first_date}~${record.last_date}) · ${rowCount}행 · 끝난 종목 ${ended} · 요청 ${record.requests} · UA 전환 ${record.ua_switches} · 재시도 ${record.retries} · ${formatDuration(record.duration_ms)} · 남은 종목 ${cursor.size}`);
    await afterRound(record);
  }
  if (!summary.stopped) summary.stopped = cursor.size ? "max_rounds" : "source_exhausted";
  summary.request_stats = request.stats();
  summary.remaining_symbols = cursor.size;
  summary.duration_ms = now().getTime() - startedAt;
  log(`종료 · ${summary.rounds.length}바퀴 · 가장 오래된 날짜 ${summary.oldest_date ?? "-"} · 남은 종목 ${cursor.size} · 사유 ${typeof summary.stopped === "string" ? summary.stopped : `${summary.stopped.symbol} ${summary.stopped.reason}`} · 총 ${formatDuration(summary.duration_ms)}`);
  log(`요청 통계 · ${formatRequestStats(summary.request_stats)}`);
  if (summary.stopped === "time_budget" || summary.stopped === "max_rounds") log(`이어 받기: 같은 워크플로우를 다시 실행하면 ${summary.oldest_date ?? before} 이전부터 계속합니다.`);
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
    const st = summary.request_stats, stop = typeof summary.stopped === "string" ? summary.stopped : `${summary.stopped.symbol} (bizdate ${summary.stopped.from}) ${summary.stopped.reason}${summary.stopped.detail ? ` · ${summary.stopped.detail}` : ""}`;
    const lines = ["### 매매동향 과거 수집", `- 시작 기준: ${summary.before} 이전 · 총 ${formatDuration(summary.duration_ms)}`, `- 저장한 바퀴: ${summary.rounds.length} · 가장 오래된 날짜: ${summary.oldest_date ?? "-"} · 남은 종목: ${summary.remaining_symbols}`, `- 종료 사유: ${stop}`, `- ${formatRequestStats(st)}`, "", "| 바퀴 | 종목 | 날짜 수 | 기간 | 행 | 끝난 종목 | 요청 | UA 전환 | 재시도 | 소요 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...summary.rounds.map((r) => `| ${r.round} | ${r.symbols} | ${r.dates} | ${r.first_date}~${r.last_date} | ${r.rows} | ${r.ended} | ${r.requests} | ${r.ua_switches} | ${r.retries} | ${formatDuration(r.duration_ms)} |`), "", "| User-Agent | 성공 |", "| --- | --- |", ...Object.entries(st.ua_success).map(([k, v]) => `| ${k} | ${v} |`)];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  if (typeof summary.stopped === "object") process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
