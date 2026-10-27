import assert from "node:assert/strict";
import test from "node:test";
import { createNaverCrawlProvider } from "../providers/naver-crawl-provider.js";
import { runAll } from "../scripts/run-all.mjs";

const RUN_START = "2026-10-27T00:30:00.000Z";

test("run-all dry-run keeps the fixed order and continues across KST time boundaries", async () => {
  const beforeOpen = await runAll(["--run-date", "2026-10-27", "--run-started-at", "2026-10-26T23:59:59Z", "--dry-run"]);
  assert.deepEqual(beforeOpen.stages.map(({ stage }) => stage), ["update-results", "analysis", "forecast", "open-settlement", "close-settlement"]);
  assert.deepEqual(beforeOpen.stages.map(({ status }) => status), ["planned", "planned", "planned", "pending", "pending"]);

  const during = await runAll(["--run-date", "2026-10-27", "--run-started-at", "2026-10-27T03:00:00Z", "--dry-run"]);
  assert.deepEqual(during.stages.map(({ status }) => status), ["pending", "pending", "pending", "planned", "pending"]);

  const afterClose = await runAll(["--run-date", "2026-10-27", "--run-started-at", "2026-10-27T06:30:00Z", "--dry-run"]);
  assert.deepEqual(afterClose.stages.map(({ status }) => status), ["pending", "pending", "pending", "planned", "planned"]);
  assert.equal(beforeOpen.dryRun, true);
});
test("run-all dry-run blocks future dates and market-closed dates without collection", async () => {
  const future = await runAll(["--run-date", "2026-10-28", "--run-started-at", RUN_START, "--dry-run"]);
  assert.equal(future.status, "blocked");
  assert.equal(future.reason, "future_date");
  const weekend = await runAll(["--run-date", "2026-10-24", "--run-started-at", RUN_START, "--dry-run"]);
  assert.equal(weekend.status, "blocked");
  assert.equal(weekend.reason, "weekend");
  const holiday = await runAll(["--run-date", "2026-10-05", "--run-started-at", RUN_START, "--dry-run"]);
  assert.equal(holiday.status, "blocked");
  assert.equal(holiday.reason, "substitute_holiday");
});

test("historical Naver registration uses exact public EOD values and never reconstructs pre-open", async () => {
  const csv = (date, close) => [
    "basDt,mrktCtg,종목코드,종목명,mkp,clpr,trqu",
    `${date},KOSPI,000001,공개종목,101,${close},1000`,
  ].join("\n");
  const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "content-type" ? "text/csv" : "text/plain" },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const date = url.match(/quotes_(\d{8})\.csv/)?.[1];
    if (date === "20261023") return response(csv(date, 103));
    if (date === "20261022") return response(csv(date, 100));
    return response("not found", 404);
  };
  const provider = createNaverCrawlProvider({
    env: { KOSPI_RUN_DATE: "2026-10-23", KOSPI_RUN_ID: "all-test.1", KOSPI_PUBLIC_MAX_RETRIES: "0", KOSPI_STABLE_SNAPSHOT: "1" },
    fetchImpl,
    now: () => new Date("2026-10-27T00:30:00.000Z"),
    runStartedAt: RUN_START,
  });
  const forecast = await provider.generateForecast();
  assert.equal(forecast.status, "no_data");
  assert.match(forecast.message, /unsupported|synthesized|reconstructed/i);
  assert.equal(forecast.source.source_date, "2026-10-23");
  const open = await provider.settleOpen();
  assert.equal(open.status, "ready");
  assert.equal(open.rows[0].actual_open, 101);
  assert.equal(open.rows[0].actual_close, null);
  const close = await provider.settleClose();
  assert.equal(close.status, "ready");
  assert.equal(close.rows[0].actual_close, 103);
  assert.equal(open.source.retrieved_at, RUN_START);
  assert.equal(close.source.retrieved_at, RUN_START);
  assert.equal(open.source.run_id, "all-test.1");
  assert.equal(close.source.run_id, "all-test.1");
});
