import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const expectedHistoricalDates = ["2026-10-22", "2026-10-23"];
const pipelineKeys = ["previousResult", "analysis", "forecast", "openSettlement", "closeSettlement"];

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
}

function checkHistoricalSnapshot(snapshot, date) {
  const errors = [];
  const warnings = [];
  let zeroObservedCount = 0;
  const seen = new Set();
  if (snapshot.asOfDate !== date) errors.push(`asOfDate mismatch: ${snapshot.asOfDate}`);
  if (snapshot.meta?.source_rows !== snapshot.rows.length) errors.push("source_rows does not match rows.length");
  if (snapshot.meta?.source_raw_rows < snapshot.rows.length) errors.push("source_raw_rows is smaller than KOSPI rows");
  if (snapshot.provider?.source?.license_status !== "confirmed") errors.push("source license is not confirmed");
  if (!String(snapshot.provider?.source?.url || "").startsWith("https://")) errors.push("source URL is not HTTPS");
  if (!snapshot.provider?.source?.retrieved_at || Number.isNaN(Date.parse(snapshot.provider.source.retrieved_at))) errors.push("retrieved_at is missing or invalid");
  if (!snapshot.baseline?.input_through_date || snapshot.baseline.input_through_date >= date) errors.push("baseline input includes target-date data");
  if (snapshot.baseline?.model !== "public_daily_momentum_volatility_v1") errors.push("historical baseline model is missing or unexpected");
  if (!Array.isArray(snapshot.baseline?.input_dates) || snapshot.baseline.input_dates.length !== 5) errors.push("historical baseline input_dates must contain five sessions");
  if (!pipelineKeys.every((key) => snapshot.pipeline?.[key]?.status)) errors.push("pipeline stage status is incomplete");

  if (snapshot.rows.every((row) => row.expected_return === 0)) errors.push("expected_return is zero for every row");

  for (const row of snapshot.rows) {
    if (seen.has(row.symbol)) errors.push(`duplicate symbol: ${row.symbol}`);
    seen.add(row.symbol);
    if (!(row.actual_open >= 0 && row.actual_close > 0 && row.actual_volume >= 0)) errors.push(`invalid observed value: ${row.symbol}`);
    if (row.actual_open === 0 || row.actual_volume === 0) zeroObservedCount += 1;
    if (!(row.prior_close > 0)) errors.push(`prior_close missing: ${row.symbol}`);
    const derivedActualReturn = ((row.actual_open / row.prior_close) - 1) * 100;
    if (Math.abs(derivedActualReturn - row.actual_return) > 0.011) errors.push(`actual_return mismatch: ${row.symbol}`);
    const derivedSessionReturn = row.actual_open > 0 ? ((row.actual_close / row.actual_open) - 1) * 100 : null;
    if (derivedSessionReturn === null ? row.session_return !== null : Math.abs(derivedSessionReturn - row.session_return) > 0.011) errors.push(`session_return mismatch: ${row.symbol}`);
    const derivedExpectedReturn = ((row.expected_open / row.prior_close) - 1) * 100;
    if (Math.abs(derivedExpectedReturn - row.expected_return) > 0.011) errors.push(`expected_return mismatch: ${row.symbol}`);
    if (Math.abs((row.actual_return - row.expected_return) - row.error) > 0.011) errors.push(`error mismatch: ${row.symbol}`);
    if (!row.features || !Number.isFinite(row.features.momentum) || !Number.isFinite(row.features.volatility)) errors.push(`baseline features missing: ${row.symbol}`);
  }
  const ranks = snapshot.rows.map((row) => row.rank);
  if (new Set(ranks).size !== ranks.length || ranks.some((rank, index) => rank !== index + 1)) errors.push("rank sequence is not contiguous");
  if (zeroObservedCount > 0) warnings.push(`${zeroObservedCount} rows contain source-reported zero open or volume; treat as non-tradable/needs-status-master review.`);
  return { date, rows: snapshot.rows.length, zero_observed_rows: zeroObservedCount, warnings, errors };
}

function buildMatrix(latest) {
  return [
    { area: "시간·거래일", currently_collected: "historical-test only", contract_only: "KST schedule and stage keys", not_contracted: "holiday/calendar source", note: "workflow cron is configured; actual Actions timing is not verified" },
    { area: "종목 마스터", currently_collected: "historical-test symbol/name", contract_only: "row schema", not_contracted: "security type, listing status, delisting, suspension", note: "source has no security-type field" },
    { area: "일별 가격·거래", currently_collected: "public-csv EOD bulk adapter + historical-test", contract_only: "expected/actual fields", not_contracted: "licensed intraday provider", note: "public-csv only exposes observed daily open/close/volume" },
    { area: "분봉·장전", currently_collected: "없음", contract_only: "없음", not_contracted: "minute candles, indicative price, 10-level book, depth, spread, trade strength", note: "no provider or credentials added" },
    { area: "시장·수급", currently_collected: "없음", contract_only: "없음", not_contracted: "KOSPI200, futures/basis, FX, sectors, foreign/institution/program flow", note: "must remain null/no_data until licensed source exists" },
    { area: "품질", currently_collected: "source URL/license/timestamps plus public-csv stale/partial/deadline metrics", contract_only: "source metadata, schema, no_data/partial/degraded", not_contracted: "external alert delivery", note: "audit checks stored snapshots; live source health is run-specific" },
    { area: "저장·파이프라인", currently_collected: latest.status === "no_data" ? "no_data state" : latest.status, contract_only: "stage state, idempotent file replacement", not_contracted: "run ledger, immutable raw archive, alert delivery", note: "public JSON contains no secrets" },
  ];
}

async function main() {
  const latest = await readJson("data/latest-snapshot.json");
  const historical = [];
  for (const date of expectedHistoricalDates) historical.push(checkHistoricalSnapshot(await readJson(`data/historical-test/${date}.json`), date));
  const result = {
    generated_at: new Date().toISOString(),
    operating_provider: process.env.KOSPI_PROVIDER || "public-csv",
    operating_status: process.env.KOSPI_PROVIDER ? "configured_by_environment" : "default_public_csv",
    snapshot_provider: latest.provider?.id ?? null,
    snapshot_mode: latest.mode,
    matrix: buildMatrix(latest),
    historical_snapshots: historical,
    pass: historical.every((item) => item.errors.length === 0),
    limitations: [
      "The default public-csv provider collects daily bulk CSV only; no real pre-market or order-book values are generated.",
      "Historical daily files are not historical 08:20 snapshots and must not be reported as forecast performance.",
      "The public site must not publish raw licensed data beyond the source terms.",
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
