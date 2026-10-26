import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_CALENDAR_PATH = fileURLToPath(new URL("../data/krx-market-holidays.json", import.meta.url));
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day;
}

export function kstDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function assertCalendar(calendar) {
  if (!calendar || calendar.market !== "KOSPI" || calendar.timezone !== "Asia/Seoul") {
    throw new Error("KOSPI market calendar contract is invalid.");
  }
  if (!isValidDate(calendar.coverage?.start) || !isValidDate(calendar.coverage?.end) || calendar.coverage.start > calendar.coverage.end) {
    throw new Error("KOSPI market calendar coverage is invalid.");
  }
  if (!Array.isArray(calendar.holidays) || calendar.holidays.some((holiday) => !isValidDate(holiday.date) || !holiday.name || !holiday.kind)) {
    throw new Error("KOSPI market calendar holiday entries are invalid.");
  }
  const dates = calendar.holidays.map((holiday) => holiday.date);
  if (new Set(dates).size !== dates.length || dates.some((date) => date < calendar.coverage.start || date > calendar.coverage.end)) {
    throw new Error("KOSPI market calendar holiday dates are outside coverage or duplicated.");
  }
  return calendar;
}

export async function loadMarketCalendar(path = DEFAULT_CALENDAR_PATH) {
  return assertCalendar(JSON.parse(await readFile(path, "utf8")));
}

export function classifyMarketDate(date, calendar) {
  if (!isValidDate(date)) throw new Error(`Invalid market date: ${date}`);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return { status: "skip", date, reason: "weekend", message: "KOSPI is closed on Saturday and Sunday." };
  }
  assertCalendar(calendar);
  if (date < calendar.coverage.start || date > calendar.coverage.end) {
    return {
      status: "error",
      date,
      reason: "calendar_coverage_missing",
      message: `No checked-in KRX calendar covers ${date}; refusing to collect data.`,
    };
  }
  const holiday = calendar.holidays.find((entry) => entry.date === date);
  if (holiday) return { status: "skip", date, reason: holiday.kind, holiday, message: `${holiday.name}: KOSPI is closed.` };
  return { status: "run", date, reason: "trading_day", message: "KOSPI trading day confirmed by the checked-in KRX calendar." };
}

export async function checkMarketDate(date, { calendarPath = DEFAULT_CALENDAR_PATH } = {}) {
  return classifyMarketDate(date, await loadMarketCalendar(calendarPath));
}
