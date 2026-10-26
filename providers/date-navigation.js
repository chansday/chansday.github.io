export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const CALENDAR_MODES = Object.freeze({
  provider: { label: "운영 데이터", root: "data/runs", stage: "1530" },
  "historical-test": { label: "과거 시험 데이터", root: "data/runs/historical-test", stage: "1530" },
  fixture: { label: "합성 시험 데이터", root: "data/fixtures", extension: "json" },
  replay: { label: "합성 재생 기준선", root: "data/replays", extension: "json" },
  "backfill-test": { label: "시험용 보충 데이터", root: "data/backfill-test", extension: "json" },
});

export function isIsoDate(value) {
  if (!DATE_PATTERN.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeMode(mode) {
  const value = String(mode || "provider").toLowerCase().replaceAll("_", "-");
  return value === "backfill-test" ? value : Object.hasOwn(CALENDAR_MODES, value) ? value : "provider";
}

export function normalizeDateIndex(index) {
  const availableDates = {};
  for (const mode of Object.keys(CALENDAR_MODES)) {
    const rawDates = Array.isArray(index?.availableDates?.[mode]) ? index.availableDates[mode] : [];
    availableDates[mode] = [...new Set(rawDates.map((date) => typeof date === "string" ? date : date?.date).filter(isIsoDate))].sort();
  }
  return { schemaVersion: index?.schemaVersion || "1.0.0", availableDates };
}

export function snapshotPath(mode, date) {
  const normalizedMode = normalizeMode(mode);
  if (!isIsoDate(date)) throw new Error("Snapshot date is invalid");
  const config = CALENDAR_MODES[normalizedMode];
  if (config.extension) return `${config.root}/${encodeURIComponent(date)}.${config.extension}`;
  return `${config.root}/${encodeURIComponent(date)}/${config.stage}.json`;
}

export function holidayForDate(date, calendar) {
  if (!isIsoDate(date)) return null;
  const holiday = Array.isArray(calendar?.holidays) ? calendar.holidays.find((item) => item?.date === date) : null;
  if (holiday) return { ...holiday, status: "holiday" };
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 ? { date, name: "주말 휴장", kind: "weekend", status: "holiday" } : null;
}

export function classifyDate(date, mode, index, calendar) {
  const normalizedMode = normalizeMode(mode);
  if (!isIsoDate(date)) return { date, mode: normalizedMode, status: "error", label: "오류", reason: "invalid_date" };
  const holiday = holidayForDate(date, calendar);
  if (holiday) return { date, mode: normalizedMode, status: "holiday", label: "휴장일", reason: holiday.name, holiday };
  const available = normalizeDateIndex(index).availableDates[normalizedMode].includes(date);
  return { date, mode: normalizedMode, status: available ? "available" : "not_collected", label: available ? "결과 있음" : "미수집" };
}

export function statusLabel(status) {
  return ({ available: "결과 있음", loading: "조회 중", not_collected: "미수집", holiday: "휴장일", error: "오류" })[status] || "상태 확인 필요";
}
