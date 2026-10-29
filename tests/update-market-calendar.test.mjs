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

test("scheduled December runs no-op when covered and retry later while KRX has not published", async () => {
  const dir = await mkdtemp(join(tmpdir(), "krx-calendar-cli-"));
  const path = join(dir, "calendar.json"), summaryPath = join(dir, "summary.md");
  const noFetch = async () => { throw new Error("no request expected"); };
  const logs = [];
  try {
    const existing = JSON.parse(await readFile(new URL("../data/krx-market-holidays.json", import.meta.url), "utf8"));
    const base = { ...existing, coverage: { ...existing.coverage, end: "2026-12-31" }, holidays: existing.holidays.filter((item) => item.date.startsWith("2026-")) };
    await writeFile(path, JSON.stringify(base));
    const before = await readFile(path, "utf8");
    const unpublished = mockFetch({ block1: rows.slice(0, 3) });
    const early = await runCalendarUpdateCli({ today: "2026-12-20", path, fetchImpl: unpublished, summaryPath, log: (line) => logs.push(line) });
    assert.equal(early.status, "krx_unavailable_retry_later"); assert.equal(early.exitCode, 0);
    assert.match(logs.join("\n"), /^::warning::KRX 2027 market calendar is not available yet/m);
    assert.match(await readFile(summaryPath, "utf8"), /later scheduled December run retries/);
    assert.equal(await readFile(path, "utf8"), before);
    await assert.rejects(runCalendarUpdateCli({ today: "2026-12-31", path, fetchImpl: unpublished, summaryPath, log: () => {} }), /Incomplete/);
    const updated = await runCalendarUpdateCli({ today: "2026-12-24", path, fetchImpl: mockFetch(), summaryPath, log: () => {} });
    assert.equal(updated.status, "updated"); assert.equal(updated.exitCode, 0);
    const covered = await runCalendarUpdateCli({ today: "2026-12-27", path, fetchImpl: noFetch, summaryPath, log: () => {} });
    assert.equal(covered.status, "already_covered"); assert.equal(covered.changed, false); assert.equal(covered.exitCode, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("only transient KRX failures are retried later; structural ones and final or January attempts fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "krx-calendar-classes-"));
  const path = join(dir, "calendar.json");
  const page = '<form action="/contents/OPN/99/OPN99000001.jspx" data-bld="MKD/01/0110/01100305/mkd01100305_01">';
  const krx = ({ pageText = page, otp = "form-token", data = JSON.stringify({ block1: rows }), status = 200 } = {}) => async (url) => {
    const target = new URL(url).pathname;
    if (status !== 200) return new Response("unavailable", { status });
    if (target.endsWith("MKD01100305.jsp")) return new Response(pageText);
    if (target.endsWith("GenerateOTP.jspx")) return new Response(otp);
    if (target.endsWith("OPN99000001.jspx")) return new Response(data);
    throw new Error("Unexpected request");
  };
  const transient = {
    network: async () => { throw new TypeError("fetch failed"); },
    timeout: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
    http503: krx({ status: 503 }),
    http429: krx({ status: 429 }),
    incomplete: krx({ data: JSON.stringify({ block1: rows.slice(0, 3) }) }),
    missingYearEnd: krx({ data: JSON.stringify({ block1: [...rows.slice(0, 5), { calnd_dd: "2027-12-24", calnd_dd_dy: "2027-12-24", holdy_nm: "성탄절" }] }) }),
  };
  const structural = {
    http404: krx({ status: 404 }),
    formChanged: krx({ pageText: "<html>maintenance</html>" }),
    tokenAnomaly: krx({ otp: "<html>" }),
    invalidJson: krx({ data: "not json" }),
    wrongYear: krx({ data: JSON.stringify({ block1: rows.map((row) => ({ ...row, calnd_dd: row.calnd_dd.replace("2027", "2028"), calnd_dd_dy: null })) }) }),
    duplicate: krx({ data: JSON.stringify({ block1: [...rows, rows[0]] }) }),
    malformed: krx({ data: JSON.stringify({ rows }) }),
  };
  try {
    const existing = JSON.parse(await readFile(new URL("../data/krx-market-holidays.json", import.meta.url), "utf8"));
    const base = { ...existing, coverage: { ...existing.coverage, end: "2026-12-31" }, holidays: existing.holidays.filter((item) => item.date.startsWith("2026-")) };
    await writeFile(path, JSON.stringify(base));
    const before = await readFile(path, "utf8");
    const run = (today, fetchImpl, logs = []) => runCalendarUpdateCli({ today, path, fetchImpl, summaryPath: null, log: (line) => logs.push(line) });
    for (const [name, fetchImpl] of Object.entries(transient)) {
      const logs = [];
      const early = await run("2026-12-20", fetchImpl, logs);
      assert.equal(early.status, "krx_unavailable_retry_later", name); assert.equal(early.exitCode, 0, name);
      assert.match(logs.join("\n"), /^::warning::KRX 2027 /m, name);
      await assert.rejects(run("2026-12-31", fetchImpl), undefined, `${name} on the final December attempt`);
      await assert.rejects(run("2027-01-01", fetchImpl), undefined, `${name} in January`);
    }
    for (const [name, fetchImpl] of Object.entries(structural)) {
      for (const today of ["2026-12-20", "2026-12-31", "2027-01-01"]) await assert.rejects(run(today, fetchImpl), undefined, `${name} on ${today}`);
    }
    assert.equal(await readFile(path, "utf8"), before);
    // A delayed Dec 31 schedule that starts on Jan 1 KST still targets the year that just began.
    const january = await run("2027-01-01", krx());
    assert.equal(january.status, "updated"); assert.equal(january.year, 2027);
    assert.equal((await checkMarketDate("2027-02-09", { calendarPath: path })).status, "skip");
    const coveredInJanuary = await run("2027-01-02", async () => { throw new Error("no request expected"); });
    assert.equal(coveredInJanuary.status, "already_covered"); assert.equal(coveredInJanuary.year, 2027);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
