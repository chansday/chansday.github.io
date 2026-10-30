import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchKrxHolidays, parseKrxHolidays, runCalendarUpdateCli, updateMarketCalendar } from "../scripts/update-market-calendar.mjs";
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

// Year-aware KRX mock: specs[year] is a block1 array, an HTTP status, or "network".
const PAGE_HTML = '<form action="/contents/OPN/99/OPN99000001.jspx" data-bld="MKD/01/0110/01100305/mkd01100305_01">';
function krxByYear(specs, requested = []) {
  return async (url, options = {}) => {
    const target = new URL(url).pathname;
    if (target.endsWith("MKD01100305.jsp")) return new Response(PAGE_HTML);
    if (target.endsWith("GenerateOTP.jspx")) return new Response("form-token");
    if (!target.endsWith("OPN99000001.jspx")) throw new Error("Unexpected request");
    const year = Number(options.body.get("search_bas_yy")); requested.push(year);
    const spec = specs[year];
    if (spec === undefined) throw new Error(`no request expected for ${year}`);
    if (spec === "network") throw new TypeError("fetch failed");
    if (typeof spec === "number") return new Response("unavailable", { status: spec });
    if (typeof spec === "string") return new Response(spec);
    return new Response(JSON.stringify({ block1: spec }));
  };
}

async function calendarFixture(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix)), path = join(dir, "calendar.json");
  const existing = JSON.parse(await readFile(new URL("../data/krx-market-holidays.json", import.meta.url), "utf8"));
  const base = { ...existing, coverage: { ...existing.coverage, end: "2026-12-31" }, holidays: existing.holidays.filter((item) => item.date.startsWith("2026-")) };
  await writeFile(path, JSON.stringify(base));
  const rows2026 = base.holidays.map(({ date, name }) => ({ calnd_dd: date, calnd_dd_dy: date, holdy_nm: name }));
  return { dir, path, rows2026 };
}

test("daily runs re-check the current year: mid-year additions are applied, unchanged lists and transient failures change nothing", async () => {
  const { dir, path, rows2026 } = await calendarFixture("krx-calendar-daily-");
  const run = (today, fetchImpl, logs = []) => runCalendarUpdateCli({ today, path, fetchImpl, summaryPath: null, log: (line) => logs.push(line) });
  try {
    const before = await readFile(path, "utf8"), requested = [];
    const same = await run("2026-10-30", krxByYear({ 2026: rows2026 }, requested));
    assert.equal(same.status, "unchanged"); assert.deepEqual(requested, [2026], "no next-year request before December");
    assert.equal(await readFile(path, "utf8"), before);
    const logs = [];
    const flaky = await run("2026-10-30", krxByYear({ 2026: 503 }), logs);
    assert.equal(flaky.status, "krx_unavailable_retry_later"); assert.equal(flaky.exitCode, 0);
    assert.match(logs.join("\n"), /^::warning::KRX 2026 .*next daily run will retry/m);
    assert.equal(await readFile(path, "utf8"), before);
    const temporary = { calnd_dd: "2026-11-20", calnd_dd_dy: "2026-11-20", holdy_nm: "임시휴장일" };
    const added = await run("2026-10-30", krxByYear({ 2026: [...rows2026, temporary] }));
    assert.equal(added.status, "updated"); assert.equal(added.changed, true);
    assert.equal((await checkMarketDate("2026-11-20", { calendarPath: path })).status, "skip");
    assert.equal(JSON.parse(await readFile(path, "utf8")).coverage.end, "2026-12-31", "a refresh never moves coverage");
    await assert.rejects(run("2026-10-31", krxByYear({ 2026: rows2026 })), /manual review/, "a holiday that disappears is not removed automatically");
    for (const structural of [404, "not json", "<html>"]) await assert.rejects(run("2026-10-31", krxByYear({ 2026: structural })), undefined, String(structural));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("December runs add the next year once KRX publishes it; Dec 31 and an uncovered current year are final", async () => {
  const { dir, path, rows2026 } = await calendarFixture("krx-calendar-december-");
  const run = (today, fetchImpl) => runCalendarUpdateCli({ today, path, fetchImpl, summaryPath: null, log: () => {} });
  try {
    const before = await readFile(path, "utf8");
    for (const unpublished of [rows.slice(0, 3), "network", 429]) {
      const early = await run("2026-12-20", krxByYear({ 2026: rows2026, 2027: unpublished }));
      assert.equal(early.status, "krx_unavailable_retry_later", String(unpublished)); assert.equal(early.exitCode, 0);
      await assert.rejects(run("2026-12-31", krxByYear({ 2026: rows2026, 2027: unpublished })), undefined, `${unpublished} on Dec 31`);
    }
    assert.equal(await readFile(path, "utf8"), before);
    // A January run with the new year still uncovered fails on any KRX error.
    await assert.rejects(run("2027-01-01", krxByYear({ 2027: "network" })));
    const january = await run("2027-01-01", krxByYear({ 2027: rows }));
    assert.equal(january.status, "updated"); assert.equal(JSON.parse(await readFile(path, "utf8")).coverage.end, "2027-12-31");
    await writeFile(path, before);
    const published = await run("2026-12-24", krxByYear({ 2026: rows2026, 2027: rows }));
    assert.equal(published.status, "updated"); assert.equal((await checkMarketDate("2027-02-09", { calendarPath: path })).status, "skip");
    const requested = [];
    const covered = await run("2026-12-27", krxByYear({ 2026: rows2026, 2027: rows }, requested));
    assert.equal(covered.status, "unchanged"); assert.deepEqual(requested, [2026, 2027], "a covered next year is re-checked too");
    const flakyNext = await run("2026-12-31", krxByYear({ 2026: rows2026, 2027: "network" }));
    assert.equal(flakyNext.status, "krx_unavailable_retry_later", "a covered year only warns");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
