import { appendFile, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DEFAULT_CALENDAR_PATH, isValidDate, kstDate, loadMarketCalendar } from "./market-calendar.mjs";

const ORIGIN = "https://open.krx.co.kr";
const PAGE = "/contents/MKD/01/0110/01100305/MKD01100305.jsp";
const BLD = "MKD/01/0110/01100305/mkd01100305_01";
const ENDPOINT = "/contents/OPN/99/OPN99000001.jspx";

async function checkedFetch(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`KRX request failed: HTTP ${response.status}`);
  return response;
}

export async function fetchKrxHolidays(year, fetchImpl = globalThis.fetch) {
  if (!Number.isInteger(year) || year < 2026 || year > 9999) throw new Error("Invalid target year");
  const page = await checkedFetch(fetchImpl, ORIGIN + PAGE);
  const pageText = await page.text();
  if (!pageText.includes(`data-bld="${BLD}"`) || !pageText.includes(ENDPOINT)) throw new Error("KRX holiday form changed");
  const cookies = (page.headers.getSetCookie?.() || []).map((cookie) => cookie.split(";", 1)[0]).join("; ");
  const headers = { Referer: ORIGIN + PAGE, ...(cookies ? { Cookie: cookies } : {}) };
  const otpUrl = new URL("/contents/COM/GenerateOTP.jspx", ORIGIN);
  otpUrl.search = new URLSearchParams({ bld: BLD, name: "form" }).toString();
  const otp = (await (await checkedFetch(fetchImpl, otpUrl, { headers })).text()).trim();
  if (!otp || otp.length > 4096 || /[<>\r\n]/.test(otp)) throw new Error("KRX form token unavailable");
  const body = new URLSearchParams({ search_bas_yy: String(year), gridTp: "KRX", pagePath: PAGE, code: otp, pageFirstCall: "Y" });
  const response = await checkedFetch(fetchImpl, ORIGIN + ENDPOINT, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body });
  let json;
  try { json = JSON.parse(await response.text()); } catch { throw new Error("KRX response is not valid JSON"); }
  return parseKrxHolidays(json, year);
}

export function parseKrxHolidays(json, year) {
  if (!Array.isArray(json?.block1) || json.block1.length < 5 || json.block1.length > 50) throw new Error("Incomplete KRX holiday list");
  const seen = new Set();
  const holidays = json.block1.map((row) => {
    const date = row?.calnd_dd, name = row?.holdy_nm?.trim();
    if (!isValidDate(date) || !date.startsWith(`${year}-`) || !name || name.length > 100 || seen.has(date) || (row.calnd_dd_dy && row.calnd_dd_dy !== date)) throw new Error("Invalid or duplicate KRX holiday");
    seen.add(date);
    const kind = /대체/.test(name) ? "substitute_holiday" : /임시/.test(name) ? "temporary_holiday" : /연말|근로|노동/.test(name) ? "market_holiday" : "public_holiday";
    return { date, name, kind };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const first = `${year}-01-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay();
  if (weekday !== 0 && weekday !== 6 && !seen.has(first)) throw new Error("KRX list is missing New Year's Day");
  if (!holidays.some((item) => item.date.startsWith(`${year}-12-`) && /연말/.test(item.name))) throw new Error("KRX list is missing the year-end market closure");
  return holidays;
}

export function extendCalendar(calendar, year, holidays, retrievedAt) {
  if (!Array.isArray(holidays) || !holidays.length || !isValidDate(retrievedAt)) throw new Error("Invalid update input");
  const endYear = Number(calendar.coverage.end.slice(0, 4));
  if (calendar.coverage.end !== `${endYear}-12-31` || year < endYear || year > endYear + 1) throw new Error("Calendar years must remain contiguous");
  const oldYear = calendar.holidays.filter((item) => item.date.startsWith(`${year}-`));
  const fetchedDates = new Set(holidays.map((item) => item.date));
  if (oldYear.some((item) => !fetchedDates.has(item.date))) throw new Error("Existing holiday missing from new KRX response; manual review required");
  const prior = calendar.holidays.filter((item) => !item.date.startsWith(`${year}-`));
  return { ...calendar, source: { ...calendar.source, name: "한국거래소(KRX) 휴장일 조회", url: ORIGIN + PAGE, retrievedAt, updatePolicy: "매년 12월 31일 다음 연도를 공식 조회하여 추가; 연중 변경은 별도 확인 필요." }, coverage: { ...calendar.coverage, end: `${year}-12-31` }, holidays: [...prior, ...holidays].sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function updateMarketCalendar({ year, path = DEFAULT_CALENDAR_PATH, fetchImpl = globalThis.fetch, today = kstDate(), dryRun = false } = {}) {
  const initial = await readFile(path, "utf8");
  const calendar = await loadMarketCalendar(path);
  let holidays;
  try { holidays = await fetchKrxHolidays(year, fetchImpl); }
  catch (error) { error.krxUnavailable = true; throw error; }
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

// The scheduled job runs on several late-December days. The last one is the
// final attempt before the checked-in coverage ends; earlier ones may find that
// KRX has not published next year's list yet and leave the retry to a later day.
export const FINAL_ATTEMPT_MONTH_DAY = "12-31";

async function appendSummary(summaryPath, lines) {
  if (!summaryPath) return;
  await appendFile(summaryPath, `${["### KRX market calendar update", ...lines].join("\n")}\n`, "utf8");
}

export async function runCalendarUpdateCli({ today = kstDate(), path = DEFAULT_CALENDAR_PATH, fetchImpl = globalThis.fetch, dryRun = false, summaryPath = process.env.GITHUB_STEP_SUMMARY, log = console.log } = {}) {
  if (!isValidDate(today)) throw new Error("Invalid KST date");
  const year = Number(today.slice(0, 4)) + 1;
  const calendar = await loadMarketCalendar(path);
  if (calendar.coverage.end >= `${year}-12-31`) {
    await appendSummary(summaryPath, [`- ${year}: already covered (coverage ends ${calendar.coverage.end}); no KRX request.`]);
    return { status: "already_covered", changed: false, year, exitCode: 0 };
  }
  try {
    const result = await updateMarketCalendar({ year, path, fetchImpl, today, dryRun });
    const status = result.changed ? "updated" : result.wouldChange ? "dry_run_would_change" : "unchanged";
    await appendSummary(summaryPath, [`- ${year}: ${status} (${result.count} KRX holidays).`]);
    return { status, ...result, exitCode: 0 };
  } catch (error) {
    if (!error.krxUnavailable || today.slice(5) >= FINAL_ATTEMPT_MONTH_DAY) throw error;
    const reason = String(error.message).replace(/[\r\n]+/g, " ");
    log(`::warning::KRX ${year} market calendar is not available yet (${reason}); a later scheduled run will retry.`);
    await appendSummary(summaryPath, [`- ${year}: KRX list not available yet (${reason}).`, "- calendar unchanged; a later scheduled December run retries."]);
    return { status: "krx_unavailable_retry_later", changed: false, year, reason, exitCode: 0 };
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCalendarUpdateCli({ dryRun: process.env.KOSPI_CALENDAR_DRY_RUN === "true" }).then((result) => {
    const { exitCode, ...rest } = result;
    console.log(JSON.stringify(rest));
    process.exitCode = exitCode;
  }).catch((error) => { console.error(`KRX calendar update failed: ${error.message}`); process.exitCode = 1; });
}
