import { appendFile, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DEFAULT_CALENDAR_PATH, isValidDate, kstDate, loadMarketCalendar } from "./market-calendar.mjs";

const ORIGIN = "https://open.krx.co.kr";
const PAGE = "/contents/MKD/01/0110/01100305/MKD01100305.jsp";
const BLD = "MKD/01/0110/01100305/mkd01100305_01";
const ENDPOINT = "/contents/OPN/99/OPN99000001.jspx";

// Errors a later scheduled run may resolve (network, timeout, HTTP 5xx/429, a
// list KRX has not fully published yet) carry krxRetryable=true. Every other
// error (form or token change, invalid JSON, malformed rows, other HTTP 4xx)
// is structural and fails immediately.
function krxError(message, retryable = false) {
  const error = new Error(message);
  error.krxRetryable = retryable;
  return error;
}

async function checkedFetch(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) }); }
  catch (error) { throw krxError(`KRX request failed: ${error?.name === "TimeoutError" ? "timeout" : error?.message || "network error"}`, true); }
  if (!response.ok) throw krxError(`KRX request failed: HTTP ${response.status}`, response.status >= 500 || response.status === 429);
  return response;
}

async function readText(response) {
  try { return await response.text(); }
  catch (error) { throw krxError(`KRX response could not be read: ${error?.message || "network error"}`, true); }
}

export async function fetchKrxHolidays(year, fetchImpl = globalThis.fetch) {
  if (!Number.isInteger(year) || year < 2026 || year > 9999) throw krxError("Invalid target year");
  const page = await checkedFetch(fetchImpl, ORIGIN + PAGE);
  const pageText = await readText(page);
  if (!pageText.includes(`data-bld="${BLD}"`) || !pageText.includes(ENDPOINT)) throw krxError("KRX holiday form changed");
  const cookies = (page.headers.getSetCookie?.() || []).map((cookie) => cookie.split(";", 1)[0]).join("; ");
  const headers = { Referer: ORIGIN + PAGE, ...(cookies ? { Cookie: cookies } : {}) };
  const otpUrl = new URL("/contents/COM/GenerateOTP.jspx", ORIGIN);
  otpUrl.search = new URLSearchParams({ bld: BLD, name: "form" }).toString();
  const otp = (await readText(await checkedFetch(fetchImpl, otpUrl, { headers }))).trim();
  if (!otp || otp.length > 4096 || /[<>\r\n]/.test(otp)) throw krxError("KRX form token unavailable");
  const body = new URLSearchParams({ search_bas_yy: String(year), gridTp: "KRX", pagePath: PAGE, code: otp, pageFirstCall: "Y" });
  const response = await checkedFetch(fetchImpl, ORIGIN + ENDPOINT, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body });
  let json;
  const text = await readText(response);
  try { json = JSON.parse(text); } catch { throw krxError("KRX response is not valid JSON"); }
  return parseKrxHolidays(json, year);
}

export function parseKrxHolidays(json, year) {
  if (!Array.isArray(json?.block1) || json.block1.length > 50) throw krxError("Malformed KRX holiday list");
  if (json.block1.length < 5) throw krxError("Incomplete KRX holiday list", true);
  const seen = new Set();
  const holidays = json.block1.map((row) => {
    const date = row?.calnd_dd, name = row?.holdy_nm?.trim();
    if (!isValidDate(date) || !date.startsWith(`${year}-`) || !name || name.length > 100 || seen.has(date) || (row.calnd_dd_dy && row.calnd_dd_dy !== date)) throw krxError("Invalid or duplicate KRX holiday");
    seen.add(date);
    const kind = /대체/.test(name) ? "substitute_holiday" : /임시/.test(name) ? "temporary_holiday" : /연말|근로|노동/.test(name) ? "market_holiday" : "public_holiday";
    return { date, name, kind };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const first = `${year}-01-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay();
  // A list without its first or last closure is treated as not fully published yet.
  if (weekday !== 0 && weekday !== 6 && !seen.has(first)) throw krxError("KRX list is missing New Year's Day", true);
  if (!holidays.some((item) => item.date.startsWith(`${year}-12-`) && /연말/.test(item.name))) throw krxError("KRX list is missing the year-end market closure", true);
  return holidays;
}

export const UPDATE_POLICY = "매일 KRX 휴장일 조회로 올해(12월부터는 다음 연도 포함)를 다시 확인해 임시휴장·대체휴일 추가와 이름 변경을 반영; 기존 휴장일이 빠지면 자동 반영하지 않고 수동 검토.";

// Adds the next year or refreshes a covered year. A refresh may add holidays
// or rename them; a holiday that disappears needs manual review.
export function extendCalendar(calendar, year, holidays, retrievedAt) {
  if (!Array.isArray(holidays) || !holidays.length || !isValidDate(retrievedAt)) throw new Error("Invalid update input");
  const startYear = Number(calendar.coverage.start.slice(0, 4)), endYear = Number(calendar.coverage.end.slice(0, 4));
  if (calendar.coverage.end !== `${endYear}-12-31` || year < startYear || year > endYear + 1) throw new Error("Calendar years must remain contiguous");
  const oldYear = calendar.holidays.filter((item) => item.date.startsWith(`${year}-`));
  const fetchedDates = new Set(holidays.map((item) => item.date));
  if (oldYear.some((item) => !fetchedDates.has(item.date))) throw new Error("Existing holiday missing from new KRX response; manual review required");
  const prior = calendar.holidays.filter((item) => !item.date.startsWith(`${year}-`));
  return { ...calendar, source: { ...calendar.source, name: "한국거래소(KRX) 휴장일 조회", url: ORIGIN + PAGE, retrievedAt, updatePolicy: UPDATE_POLICY }, coverage: { ...calendar.coverage, end: year > endYear ? `${year}-12-31` : calendar.coverage.end }, holidays: [...prior, ...holidays].sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function updateMarketCalendar({ year, path = DEFAULT_CALENDAR_PATH, fetchImpl = globalThis.fetch, today = kstDate(), dryRun = false } = {}) {
  const initial = await readFile(path, "utf8");
  const calendar = await loadMarketCalendar(path);
  const holidays = await fetchKrxHolidays(year, fetchImpl);
  const next = extendCalendar(calendar, year, holidays, today);
  // Repeated same-year checks need not update retrieval metadata or create a commit.
  if (JSON.stringify(calendar.holidays) === JSON.stringify(next.holidays) && calendar.coverage.end === next.coverage.end) return { changed: false, year, count: holidays.length };
  if (dryRun) return { changed: false, wouldChange: true, dryRun: true, year, count: holidays.length };
  if (await readFile(path, "utf8") !== initial) throw new Error("Calendar changed during update");
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
  return { changed: true, year, count: holidays.length };
}

// The job runs daily. It re-checks the current year (mid-year temporary
// closures or substitute holidays) and, from December or once covered, the
// next year. A transient KRX failure on a year that is already covered only
// warns, since tomorrow's run retries. A year that is not covered yet fails on
// its final attempt: Dec 31 for the next year, or any day for the current year
// (a coverage gap that already blocks the pipeline).
export const FINAL_ATTEMPT_MONTH_DAY = "12-31";
export const NEXT_YEAR_FROM_MONTH = "12";

export function calendarUpdateTargets(today, coverageEnd) {
  const currentYear = Number(today.slice(0, 4)), covered = (year) => coverageEnd >= `${year}-12-31`;
  const targets = [{ year: currentYear, covered: covered(currentYear), finalAttempt: !covered(currentYear) }];
  if (covered(currentYear + 1) || today.slice(5, 7) >= NEXT_YEAR_FROM_MONTH) targets.push({ year: currentYear + 1, covered: covered(currentYear + 1), finalAttempt: !covered(currentYear + 1) && today.slice(5) >= FINAL_ATTEMPT_MONTH_DAY });
  return targets;
}

async function appendSummary(summaryPath, lines) {
  if (!summaryPath) return;
  await appendFile(summaryPath, `${["### KRX market calendar update", ...lines].join("\n")}\n`, "utf8");
}

async function updateYear({ year, covered, finalAttempt }, { path, fetchImpl, today, dryRun, log }) {
  try {
    const result = await updateMarketCalendar({ year, path, fetchImpl, today, dryRun });
    const status = result.changed ? "updated" : result.wouldChange ? "dry_run_would_change" : "unchanged";
    return { status, ...result, line: `- ${year}: ${status} (${result.count} KRX holidays).` };
  } catch (error) {
    if (error.krxRetryable !== true || finalAttempt) throw error;
    const reason = String(error.message).replace(/[\r\n]+/g, " ");
    log(`::warning::KRX ${year} market calendar is not available (${reason}); the next daily run will retry.`);
    return { status: "krx_unavailable_retry_later", changed: false, year, reason, line: `- ${year}: KRX list not available (${reason}); calendar ${covered ? "keeps the stored year" : "unchanged"}, the next daily run retries.` };
  }
}

export async function runCalendarUpdateCli({ today = kstDate(), path = DEFAULT_CALENDAR_PATH, fetchImpl = globalThis.fetch, dryRun = false, summaryPath = process.env.GITHUB_STEP_SUMMARY, log = console.log } = {}) {
  if (!isValidDate(today)) throw new Error("Invalid KST date");
  const calendar = await loadMarketCalendar(path);
  // Years are updated in order so the current year is covered before the next one is appended.
  const years = [];
  for (const target of calendarUpdateTargets(today, calendar.coverage.end)) {
    years.push(await updateYear(target, { path, fetchImpl, today, dryRun, log }));
    if (years.at(-1).status === "krx_unavailable_retry_later" && !target.covered) break;
  }
  await appendSummary(summaryPath, years.map((result) => result.line));
  const changed = years.some((result) => result.changed);
  const status = changed ? "updated" : years.some((result) => result.wouldChange) ? "dry_run_would_change" : years.some((result) => result.status === "krx_unavailable_retry_later") ? "krx_unavailable_retry_later" : "unchanged";
  return { status, changed, years: years.map(({ line, ...result }) => result), exitCode: 0 };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCalendarUpdateCli({ dryRun: process.env.KOSPI_CALENDAR_DRY_RUN === "true" }).then((result) => {
    const { exitCode, ...rest } = result;
    console.log(JSON.stringify(rest));
    process.exitCode = exitCode;
  }).catch((error) => { console.error(`KRX calendar update failed: ${error.message}`); process.exitCode = 1; });
}
