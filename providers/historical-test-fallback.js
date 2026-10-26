import { isSnapshot } from "./provider-adapter.js";

export const HISTORICAL_TEST_DATES = Object.freeze(["2026-10-23", "2026-10-22"]);
export const HISTORICAL_TEST_STAGE = "1530";
export const HISTORICAL_TEST_REQUIRED_FIELDS = Object.freeze([
  "rank",
  "expected_open",
  "expected_return",
  "actual_open",
  "actual_return",
  "error",
]);

export function historicalTestRunPath(date, stage = HISTORICAL_TEST_STAGE) {
  if (!HISTORICAL_TEST_DATES.includes(date)) throw new Error(`Historical-test date is not supported: ${date}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Historical-test date is invalid: ${date}`);
  if (!/^\d{4}$/.test(stage)) throw new Error(`Historical-test stage is invalid: ${stage}`);
  return `data/runs/historical-test/${date}/${stage}.json`;
}

function hasObservedHistoricalFields(row) {
  return Boolean(
    row &&
    HISTORICAL_TEST_REQUIRED_FIELDS.every((field) => Object.hasOwn(row, field) && typeof row[field] === "number" && Number.isFinite(row[field])) &&
    Number.isInteger(row.rank) &&
    row.rank >= 1,
  );
}

export function isHistoricalTestSnapshot(snapshot) {
  return Boolean(
    isSnapshot(snapshot) &&
    snapshot.mode === "historical_test" &&
    snapshot.provider?.id === "historical-test" &&
    snapshot.meta?.historical_test === true &&
    snapshot.meta?.test_only === true &&
    snapshot.rows.length > 0 &&
    snapshot.rows.every(hasObservedHistoricalFields),
  );
}

export function isLiveNoDataSnapshot(snapshot) {
  return Boolean(
    snapshot &&
    snapshot.mode === "provider" &&
    snapshot.status === "no_data" &&
    snapshot.meta?.historical_test !== true &&
    snapshot.meta?.test_only !== true &&
    snapshot.meta?.isDemo !== true,
  );
}

export function markHistoricalTestFallback(snapshot, liveSnapshot, sourcePath) {
  if (!isHistoricalTestSnapshot(snapshot)) throw new Error("Historical-test fallback snapshot shape is invalid");
  if (!isLiveNoDataSnapshot(liveSnapshot)) throw new Error("Historical-test fallback requires a live no_data snapshot");
  return {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      historical_fallback: true,
      historical_fallback_reason: "live_provider_no_data",
      historical_fallback_source: sourcePath,
      live_snapshot_status: liveSnapshot.status,
      live_provider_id: liveSnapshot.provider?.id ?? null,
    },
  };
}

