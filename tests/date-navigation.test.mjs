import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { classifyDate, isIsoDate, normalizeDateIndex, snapshotPath } from "../providers/date-navigation.js";
import { buildDateIndex } from "../scripts/generate-date-index.mjs";

const calendar = {
  market: "KOSPI",
  holidays: [{ date: "2026-10-05", name: "개천절 대체휴일", kind: "substitute_holiday" }],
};
const index = normalizeDateIndex({ availableDates: { "historical-test": ["2026-10-22", "2026-10-23"] } });

test("date index classifies available, not collected, and KRX holiday dates", () => {
  assert.equal(classifyDate("2026-10-22", "historical-test", index, calendar).status, "available");
  assert.equal(classifyDate("2026-10-21", "historical-test", index, calendar).status, "not_collected");
  assert.equal(classifyDate("2026-10-05", "historical-test", index, calendar).status, "holiday");
  assert.equal(classifyDate("2026-10-24", "historical-test", index, calendar).status, "holiday");
});

test("date validation accepts only real ISO calendar dates", () => {
  assert.equal(isIsoDate("2026-10-22"), true);
  assert.equal(isIsoDate("2026-13-99"), false);
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.equal(classifyDate("2026-13-99", "historical-test", index, calendar).status, "error");
});

test("mode-specific paths prevent stale fallback and preserve the requested date", () => {
  assert.equal(snapshotPath("historical-test", "2026-10-22"), "data/runs/historical-test/2026-10-22/1530.json");
  assert.equal(snapshotPath("fixture", "2026-10-23"), "data/fixtures/2026-10-23.json");
  assert.equal(snapshotPath("provider", "2026-10-26"), "data/runs/2026-10-26/1530.json");
});

test("date index generator lists only dates with the configured stage file", async () => {
  const output = join(await mkdtemp(join(tmpdir(), "kospi-date-index-")), "date-index.json");
  try {
    const generated = await buildDateIndex({ output });
    assert.deepEqual(generated.availableDates["historical-test"], ["2026-10-22", "2026-10-23"]);
    assert.deepEqual(generated.availableDates.provider, []);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")).availableDates, generated.availableDates);
  } finally {
    await rm(output.replace(/\\date-index\.json$/, ""), { recursive: true, force: true });
  }
});

test("app exposes URL date routing, status messaging, and keyboard calendar hooks", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /url\.searchParams\.set\("date", date\)/);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /DateNavigationError/);
  assert.match(app, /if \(!isIsoDate\(date\)\) throw new DateNavigationError\("error"/);
  assert.match(app, /statusLabel\(status\)/);
  assert.match(app, /ArrowLeft/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /aria-disabled/);
  assert.match(app, /finally \{ if \(token === dateRequestToken\) restoreDateTriggerFocus\(\); \}/);
  assert.match(app, /function restoreDateTriggerFocus\(\)/);
  assert.match(html, /id="ranking-date-button"[^>]+type="button"/);
  assert.match(html, /id="calendar-grid"[^>]+role="grid"/);
  assert.match(html, /id="calendar-status"[^>]+aria-live="polite"/);
});
