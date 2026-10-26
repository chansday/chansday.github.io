import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildEvaluationSummary } from "../providers/evaluation-contract.js";

const TEST_DATES = Object.freeze(["2026-10-22", "2026-10-23"]);
const INPUT_DATES = Object.freeze(["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
const LOOKBACK_SESSIONS = 5;
const MOMENTUM_WEIGHT = 0.60;
const VOLATILITY_PENALTY = 0.10;
const MAX_EXPECTED_RETURN = 5;
const SOURCE_ROOT = "https://aikstockdata.com/data/public/daily";
const SOURCE_NAME = "한국주식데이터 (원천: 금융위원회 공공데이터포털·한국거래소)";
const LICENSE_URL = "https://aikstockdata.com/licenses/aiksd-public-1.1.txt";
const LICENSE_STATUS = "confirmed";

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function priorDatesFor(date) {
  if (date === "2026-10-22") return ["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"];
  if (date === "2026-10-23") return ["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"];
  throw new Error(`Unsupported historical-test date: ${date}`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const [headers, ...values] = rows;
  return values.map((valuesRow) => Object.fromEntries(headers.map((header, index) => [header, valuesRow[index] ?? ""])));
}

function numeric(row, field, date) {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) throw new Error(`${date}: ${field} is not numeric for ${row["종목코드"]}.`);
  return value;
}

async function fetchRows(date, retrievedAt) {
  const url = `${SOURCE_ROOT}/quotes_${date.replaceAll("-", "")}.csv`;
  const response = await fetch(url, { headers: { Accept: "text/csv" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  const rows = parseCsv(await response.text());
  if (rows.length === 0) throw new Error(`${url} returned no rows.`);
  const kospi = rows.filter((row) => row.mrktCtg === "KOSPI");
  if (kospi.length === 0) throw new Error(`${url} returned no KOSPI rows.`);
  for (const row of kospi) {
    if (row.basDt !== date.replaceAll("-", "")) throw new Error(`${url} contains a mismatched basDt.`);
    if (!row["종목코드"] || !row["종목명"]) throw new Error(`${url} contains a KOSPI row without symbol/name.`);
    numeric(row, "mkp", date);
    numeric(row, "clpr", date);
    numeric(row, "trqu", date);
  }
  return {
    date,
    url,
    retrievedAt,
    rawRows: rows.length,
    rows: new Map(kospi.map((row) => [row["종목코드"], row])),
  };
}

function sourceMetadata(url, retrievedAt) {
  return {
    name: SOURCE_NAME,
    url,
    license_status: LICENSE_STATUS,
    license_url: LICENSE_URL,
    retrieved_at: retrievedAt,
  };
}

function makeSnapshot(date, actual, priorDates, fetched, retrievedAt) {
  const inputThroughDate = priorDates.at(-1);
  const rows = [];
  for (const [symbol, actualRow] of actual.rows) {
    const history = priorDates.map((historyDate) => {
      const historyFile = fetched.get(historyDate);
      const historyRow = historyFile?.rows.get(symbol);
      if (!historyRow) throw new Error(`${date}: missing ${historyDate} input row for ${symbol}.`);
      return { date: historyDate, close: numeric(historyRow, "clpr", historyDate) };
    });
    const closes = history.map((item) => item.close);
    const returns = closes.slice(1).map((close, index) => (close / closes[index] - 1) * 100);
    const priorClose = closes.at(-1);
    const previousReturn = round(returns.at(-1) || 0, 4);
    const momentum = round(mean(returns.slice(-3)), 4);
    const volatility = round(standardDeviation(returns), 4);
    const rawExpectedReturn = MOMENTUM_WEIGHT * momentum - VOLATILITY_PENALTY * volatility;
    const expectedReturn = round(clamp(rawExpectedReturn, -MAX_EXPECTED_RETURN, MAX_EXPECTED_RETURN), 2);
    const expectedOpen = round(priorClose * (1 + expectedReturn / 100), 2);
    const expectedClose = null;
    const actualOpen = numeric(actualRow, "mkp", date);
    const actualClose = numeric(actualRow, "clpr", date);
    const actualVolume = numeric(actualRow, "trqu", date);
    const actualReturn = round((actualOpen / priorClose - 1) * 100, 2);
    const sessionReturn = actualOpen > 0 ? round((actualClose / actualOpen - 1) * 100, 2) : null;
    rows.push({
      rank: null,
      symbol,
      name: actualRow["종목명"],
      expected_open: expectedOpen,
      expected_close: expectedClose,
      expected_return: expectedReturn,
      actual_open: actualOpen,
      actual_close: actualClose,
      actual_return: actualReturn,
      session_return: sessionReturn,
      actual_volume: actualVolume,
      prior_close: priorClose,
      error: round(actualReturn - expectedReturn, 2),
      confidence: null,
      quality: "historical_baseline_public_daily",
      features: { previous_return: previousReturn, momentum, volatility, lookback_sessions: LOOKBACK_SESSIONS },
      status: "valid",
    });
  }
  rows.sort((a, b) => b.expected_return - a.expected_return || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => { row.rank = index + 1; });

  const source = sourceMetadata(actual.url, retrievedAt);
  const rangeNote = "mrktCtg=KOSPI; every published KOSPI row in the source daily CSV; no empty actual_open/actual_close/actual_volume rows; source does not expose a security-type field and contains no ETF rows.";
  return {
    schemaVersion: "1.0.0",
    status: "ready",
    mode: "historical_test",
    asOfDate: date,
    publishedAt: retrievedAt,
    market: { name: "KOSPI", currency: "KRW", timezone: "Asia/Seoul" },
    provider: { id: "historical-test", status: "ready", label: `HISTORICAL-TEST / TEST ONLY / ${date}`, source },
    baseline: {
      basis: "public_daily_momentum_volatility",
      reference_date: inputThroughDate,
      input_through_date: inputThroughDate,
      value_status: "retrospective_baseline_no_preopen_quote",
      model: "public_daily_momentum_volatility_v1",
      lookback_sessions: LOOKBACK_SESSIONS,
      input_dates: priorDates,
      coefficients: { momentum_weight: MOMENTUM_WEIGHT, volatility_penalty: VOLATILITY_PENALTY, max_abs_expected_return: MAX_EXPECTED_RETURN },
      formula: "previous_return = prior close / prior-prior close - 1; momentum = mean(last 3 daily returns); volatility = population standard deviation(last 4 daily returns); expected_return = clamp(round(0.60 × momentum - 0.10 × volatility, 2), -5, +5); expected_open = round(prior_close × (1 + expected_return / 100), 2); actual_return = actual_open / prior_close - 1; session_return = actual_close / actual_open - 1; error = actual_return - expected_return.",
      note: "This is a reproducible public-daily baseline generated after the fact because no historical 08:20 pre-open quote/order-book snapshot is available. It uses only the five prior trading-session daily closes, is not the historical 08:20 forecast, and must not be described as one.",
    },
    evaluation: buildEvaluationSummary(rows, {
      testOnly: true,
      dataset: "historical_test",
      asOfDate: date,
      forecastStage: "0820",
      actualStage: "0900",
      inputDates: priorDates,
      note: "Historical-test only. expected_return is the retrospective public-daily baseline; actual_return is the observed open return; error is actual_return - expected_return. This dataset is never an operating snapshot.",
    }),
    pipeline: {
      previousResult: { status: "ready", attemptedAt: retrievedAt, provider_id: "historical-test", message: `Actual prior-session input through ${inputThroughDate} was collected.` },
      analysis: { status: "ready", attemptedAt: retrievedAt, provider_id: "historical-test", message: "Historical-test input coverage and numeric fields passed validation." },
      forecast: { status: "ready", attemptedAt: retrievedAt, provider_id: "historical-test", message: `09:00 expected_open uses public_daily_momentum_volatility_v1 through ${inputThroughDate}; no historical 08:20 quote snapshot is claimed.` },
      openSettlement: { status: "ready", attemptedAt: retrievedAt, provider_id: "historical-test", message: `Historical-test actual_open is from the source ${date} daily file; it was not captured live at 09:00.` },
      closeSettlement: { status: "ready", attemptedAt: retrievedAt, provider_id: "historical-test", message: `Actual close and volume are from the source ${date} daily file.` },
    },
    rows,
    meta: {
      generatedBy: "scripts/collect-historical-test.mjs",
      lastAttemptAt: retrievedAt,
      lastAttemptMode: "historical_test",
      blockedReason: null,
      isDemo: false,
      historical_test: true,
      test_only: true,
      actual_field_note: "actual_open/actual_close/actual_volume are observed source values; actual_return is 09:00 actual_open versus prior close for evaluation; session_return is actual_close versus actual_open for intraday display; expected_open/expected_return are retrospective public-daily momentum/volatility baseline values; expected_close is null because this test targets the open.",
      source_collection_date: retrievedAt.slice(0, 10),
      source_range: rangeNote,
      source_rows: rows.length,
      source_raw_rows: actual.rawRows,
      source: {
        ...source,
        retrieved_at: retrievedAt,
      },
      data_classification: "test_only",
      evaluation_dataset: "historical_test",
      evaluation_test_only: true,
    },
  };
}

async function main() {
  const outputDir = resolve(process.cwd(), "data", "historical-test");
  const retrievedAt = new Date().toISOString();
  const fetched = new Map(await Promise.all(INPUT_DATES.map(async (date) => [date, await fetchRows(date, retrievedAt)])));
  await mkdir(outputDir, { recursive: true });
  for (const date of TEST_DATES) {
    const actual = fetched.get(date);
    const priorDates = priorDatesFor(date);
    const snapshot = makeSnapshot(date, actual, priorDates, fetched, retrievedAt);
    await writeFile(resolve(outputDir, `${date}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ date, sourceRows: actual.rawRows, kospiRows: snapshot.rows.length, retrievedAt }));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
