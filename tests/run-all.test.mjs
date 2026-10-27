import assert from "node:assert/strict";
import test from "node:test";
import { createNaverCrawlProvider } from "../providers/naver-crawl-provider.js";
import { runAll } from "../scripts/run-all.mjs";

const RUN_START = "2026-10-27T00:30:00.000Z";

test("run-all dry-run gates stages by the actual KST run-start time", async () => {
  const cases = [
    ["08:30", "2026-10-26T23:30:00Z", ["planned", "planned", "planned", "pending", "pending"]],
    ["09:00", "2026-10-27T00:00:00Z", ["planned", "planned", "planned", "planned", "pending"]],
    ["12:09", "2026-10-27T03:09:00Z", ["planned", "planned", "planned", "planned", "pending"]],
    ["15:30", "2026-10-27T06:30:00Z", ["planned", "planned", "planned", "planned", "planned"]],
    ["16:00", "2026-10-27T07:00:00Z", ["planned", "planned", "planned", "planned", "planned"]],
  ];
  for (const [label, startedAt, expectedStatuses] of cases) {
    const summary = await runAll(["--run-date", "2026-10-27", "--run-started-at", startedAt, "--dry-run"]);
    assert.deepEqual(summary.stages.map(({ stage }) => stage), ["update-results", "analysis", "forecast", "open-settlement", "close-settlement"], label);
    assert.deepEqual(summary.stages.map(({ status }) => status), expectedStatuses, label);
    assert.equal(summary.stages.filter(({ eligible }) => eligible).length, expectedStatuses.filter((status) => status === "planned").length, label);
  }
});

test("12:09 KST run calls forecast and open-settlement but not close-settlement", async () => {
  const calls = [];
  const manualFlags = [];
  const summary = await runAll([
    "--run-date", "2026-10-27",
    "--run-started-at", "2026-10-27T03:09:00Z",
    "--attempted-at", "2026-10-27T03:09:00Z",
    "--run-id", "regression-1209",
  ], {
    stageRunner: async (args) => {
      calls.push(args);
      manualFlags.push(process.env.KOSPI_MANUAL_RUN_ALL);
      return { status: "ready", message: "stubbed stage", stageFile: null };
    },
    consistencyChecker: async () => ({ status: "ready", message: "stubbed consistency" }),
  });

  assert.deepEqual(calls.map((args) => args[1]), ["update-results", "analysis", "forecast", "open-settlement"]);
  assert.equal(calls.some((args) => args.includes("close-settlement")), false);
  assert.equal(summary.status, "partial");
  assert.equal(summary.pendingOnlyPartial, true);
  assert.equal(summary.executedStagesReady, true);
  assert.equal(summary.commitAllowed, true);
  assert.match(summary.reason, /Only pending/);
  assert.equal(summary.stages.find(({ stage }) => stage === "forecast").status, "ready");
  assert.equal(summary.stages.find(({ stage }) => stage === "close-settlement").status, "pending");
  assert.deepEqual(manualFlags, ["1", "1", "1", "1"]);
});

test("08:30 KST run calls forecast but not either settlement stage", async () => {
  const calls = [];
  await runAll([
    "--run-date", "2026-10-27",
    "--run-started-at", "2026-10-26T23:30:00Z",
    "--attempted-at", "2026-10-26T23:30:00Z",
    "--run-id", "regression-0830",
  ], {
    stageRunner: async (args) => {
      calls.push(args);
      return { status: "ready", message: "stubbed stage", stageFile: null };
    },
    consistencyChecker: async () => ({ status: "ready", message: "stubbed consistency" }),
  });

  assert.deepEqual(calls.map((args) => args[1]), ["update-results", "analysis", "forecast"]);
  assert.equal(calls.some((args) => args.includes("open-settlement")), false);
  assert.equal(calls.some((args) => args.includes("close-settlement")), false);
});

test("15:30 KST run calls all five stages", async () => {
  const calls = [];
  await runAll([
    "--run-date", "2026-10-27",
    "--run-started-at", "2026-10-27T06:30:00Z",
    "--attempted-at", "2026-10-27T06:30:00Z",
    "--run-id", "regression-1530",
  ], {
    stageRunner: async (args) => {
      calls.push(args);
      return { status: "ready", message: "stubbed stage", stageFile: null };
    },
    consistencyChecker: async () => ({ status: "ready", message: "stubbed consistency" }),
  });

  assert.deepEqual(calls.map((args) => args[1]), ["update-results", "analysis", "forecast", "open-settlement", "close-settlement"]);
});

test("run-all blocks future dates and market-closed dates without collection", async () => {
  const calls = [];
  const stageRunner = async (args) => {
    calls.push(args);
    return { status: "ready", message: "should not run", stageFile: null };
  };
  const future = await runAll(["--run-date", "2026-10-28", "--run-started-at", RUN_START], { stageRunner });
  assert.equal(future.status, "blocked");
  assert.equal(future.reason, "future_date");
  const weekend = await runAll(["--run-date", "2026-10-24", "--run-started-at", RUN_START], { stageRunner });
  assert.equal(weekend.status, "blocked");
  assert.equal(weekend.reason, "weekend");
  const holiday = await runAll(["--run-date", "2026-10-05", "--run-started-at", RUN_START], { stageRunner });
  assert.equal(holiday.status, "blocked");
  assert.equal(holiday.reason, "substitute_holiday");
  assert.deepEqual(calls, []);
});

test("run-all fails closed for every executed non-ready stage outcome", async () => {
  const run = (stageStatus) => runAll([
    "--run-date", "2026-10-27",
    "--run-started-at", "2026-10-27T00:30:00Z",
    "--attempted-at", "2026-10-27T00:30:00Z",
    "--run-id", `status-${stageStatus}`,
  ], {
    stageRunner: async () => ({ status: stageStatus, message: `stubbed ${stageStatus}`, stageFile: null }),
    consistencyChecker: async () => ({ status: "ready", message: "stubbed consistency" }),
  });

  assert.equal((await run("blocked")).status, "blocked");
  assert.equal((await run("degraded")).status, "degraded");
  for (const stageStatus of ["no_data", "partial"]) {
    const summary = await run(stageStatus);
    assert.equal(summary.status, "degraded", stageStatus);
    assert.equal(summary.executedStagesReady, false, stageStatus);
    assert.equal(summary.pendingOnlyPartial, false, stageStatus);
    assert.equal(summary.commitAllowed, false, stageStatus);
    assert.match(summary.reason, /Executed stage\(s\) were not ready/, stageStatus);
  }

  const readySummary = await runAll([
    "--run-date", "2026-10-27",
    "--run-started-at", "2026-10-27T06:30:00Z",
    "--attempted-at", "2026-10-27T06:30:00Z",
    "--run-id", "status-ready",
  ], {
    stageRunner: async () => ({ status: "ready", message: "stubbed ready", stageFile: null }),
    consistencyChecker: async () => ({ status: "ready", message: "stubbed consistency" }),
  });
  assert.equal(readySummary.status, "ready");
  assert.equal(readySummary.executedStagesReady, true);
  assert.equal(readySummary.commitAllowed, true);
});

test("run-all rejects a non-ready consistency result even when every stage is ready", async () => {
  for (const consistencyStatus of ["degraded", "blocked"]) {
    const summary = await runAll([
      "--run-date", "2026-10-27",
      "--run-started-at", "2026-10-27T06:30:00Z",
      "--attempted-at", "2026-10-27T06:30:00Z",
      "--run-id", `consistency-${consistencyStatus}`,
    ], {
      stageRunner: async () => ({ status: "ready", message: "stubbed ready", stageFile: null }),
      consistencyChecker: async () => ({ status: consistencyStatus, message: `stubbed consistency ${consistencyStatus}` }),
    });

    assert.equal(summary.status, consistencyStatus, consistencyStatus);
    assert.equal(summary.executedStagesReady, false, consistencyStatus);
    assert.equal(summary.commitAllowed, false, consistencyStatus);
    assert.equal(summary.stages.find(({ stage }) => stage === "consistency").status, consistencyStatus);
  }
});

test("run-all fails closed when a stage returns an empty or unknown status", async () => {
  const summary = await runAll([
    "--run-date", "2026-10-27",
    "--run-started-at", "2026-10-27T00:30:00Z",
    "--run-id", "status-unknown",
  ], {
    stageRunner: async () => ({ status: "mystery", message: "invalid stage status", stageFile: null }),
    consistencyChecker: async () => ({ status: "ready", message: "stubbed consistency" }),
  });

  assert.equal(summary.status, "blocked");
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
