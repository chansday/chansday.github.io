import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isSnapshot } from "../providers/provider-adapter.js";

const SUPPORTED_DATES = ["2026-10-22", "2026-10-23"];
const dates = process.argv.includes("--date")
  ? [process.argv[process.argv.indexOf("--date") + 1]]
  : SUPPORTED_DATES;

for (const date of dates) {
  assert.ok(SUPPORTED_DATES.includes(date), "Unsupported backfill test date: " + date);
  const [backfill, replay] = await Promise.all([
    readFile("data/backfill-test/" + date + ".json", "utf8").then(JSON.parse),
    readFile("data/replays/" + date + ".json", "utf8").then(JSON.parse),
  ]);

  assert.equal(isSnapshot(backfill), true, "Invalid backfill test snapshot: " + date);
  assert.equal(backfill.mode, "backfill_test");
  assert.equal(backfill.status, "demo");
  assert.equal(backfill.provider?.id, "backfill-test");
  assert.equal(backfill.meta?.isDemo, true);
  assert.equal(backfill.meta?.backfill, true);
  assert.equal(backfill.meta?.backfill_source_replay_date, date);
  assert.equal(backfill.rows.length, replay.rows.length);

  const fields = ["expected_open", "expected_close", "expected_return", "actual_open", "actual_close", "actual_return", "error"];
  for (let index = 0; index < backfill.rows.length; index += 1) {
    for (const field of fields) assert.equal(backfill.rows[index][field], replay.rows[index][field], date + " row " + (index + 1) + " " + field + " diverged from replay");
    for (const field of fields) assert.equal(typeof backfill.rows[index][field], "number", date + " row " + (index + 1) + " " + field + " is not populated");
  }

  console.log(JSON.stringify({
    date,
    mode: backfill.mode,
    provider: backfill.provider.id,
    rows: backfill.rows.length,
    numericFields: fields,
    dryRun: true,
  }));
}
