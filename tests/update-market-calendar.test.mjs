import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchKrxHolidays, parseKrxHolidays, updateMarketCalendar } from "../scripts/update-market-calendar.mjs";
import { checkMarketDate } from "../scripts/market-calendar.mjs";

const rows = [
  ["2027-01-01", "신정"], ["2027-02-08", "설날"], ["2027-02-09", "설날(대체휴일)"],
  ["2027-05-05", "어린이날"], ["2027-10-11", "한글날(대체휴일)"], ["2027-12-31", "연말휴장일"],
].map(([calnd_dd, holdy_nm]) => ({ calnd_dd, calnd_dd_dy: calnd_dd, holdy_nm }));

function mockFetch(json = { block1: rows }) {
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("MKD01100305.jsp")) return new Response('<form action="/contents/OPN/99/OPN99000001.jspx" data-bld="MKD/01/0110/01100305/mkd01100305_01">');
    if (path.endsWith("GenerateOTP.jspx")) return new Response("form-token");
    if (path.endsWith("OPN99000001.jspx")) {
      assert.equal(options.method, "POST"); assert.equal(options.body.get("search_bas_yy"), "2027");
      return new Response(JSON.stringify(json));
    }
    throw new Error("Unexpected request");
  };
}

test("official form results are validated and maintain distinct holiday kinds", async () => {
  const result = await fetchKrxHolidays(2027, mockFetch());
  assert.equal(result.length, 6);
  assert.equal(result.find((row) => row.date === "2027-02-09").kind, "substitute_holiday");
  assert.equal(result.at(-1).kind, "market_holiday");
  assert.throws(() => parseKrxHolidays({ block1: rows.slice(0, -1) }, 2027), /year-end/);
  assert.throws(() => parseKrxHolidays({ block1: [...rows, rows[0]] }, 2027), /duplicate/);
  assert.throws(() => parseKrxHolidays({ block1: rows.map((row) => ({ ...row, calnd_dd: "2026-01-01" })) }, 2027), /Invalid/);
});

test("update extends coverage without removing historical holidays; repeated run is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "krx-calendar-"));
  const path = join(dir, "calendar.json");
  try {
    const existing = await readFile(new URL("../data/krx-market-holidays.json", import.meta.url), "utf8");
    // Create a fixed 2026 fixture even after the repository gains newer years.
    const base = JSON.parse(existing); base.coverage.end = "2026-12-31"; base.holidays = base.holidays.filter((item) => item.date.startsWith("2026-"));
    await writeFile(path, JSON.stringify(base));
    const beforeDryRun = await readFile(path, "utf8");
    assert.equal((await updateMarketCalendar({ year: 2027, path, fetchImpl: mockFetch(), today: "2026-12-31", dryRun: true })).wouldChange, true);
    assert.equal(await readFile(path, "utf8"), beforeDryRun);
    const updated = await updateMarketCalendar({ year: 2027, path, fetchImpl: mockFetch(), today: "2026-12-31" });
    assert.equal(updated.changed, true);
    assert.equal((await checkMarketDate("2027-02-09", { calendarPath: path })).status, "skip");
    assert.equal((await checkMarketDate("2027-02-10", { calendarPath: path })).status, "run");
    assert.equal((await checkMarketDate("2026-10-05", { calendarPath: path })).status, "skip");
    const before = await readFile(path, "utf8");
    assert.equal((await updateMarketCalendar({ year: 2027, path, fetchImpl: mockFetch(), today: "2026-12-31" })).changed, false);
    assert.equal(await readFile(path, "utf8"), before);
    await assert.rejects(updateMarketCalendar({ year: 2027, path, fetchImpl: mockFetch({ block1: rows.slice(0, 3) }), today: "2026-12-31" }), /Incomplete/);
    assert.equal(await readFile(path, "utf8"), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
