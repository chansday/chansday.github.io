import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { checkMarketDate, kstDate } from "./market-calendar.mjs";
import { resolveStage } from "./run-context.mjs";
import { run as runStage } from "./update-results.mjs";

const STAGES = Object.freeze([
  "update-results",
  "analysis",
  "forecast",
  "open-settlement",
  "close-settlement",
]);

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseArgs(argv) {
  const options = {
    runDate: null,
    runStartedAt: process.env.KOSPI_RUN_STARTED_AT || new Date().toISOString(),
    attemptedAt: null,
    runId: process.env.KOSPI_RUN_ID || null,
    dryRun: false,
    now: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-date" || arg === "--date") { options.runDate = argv[++index]; }
    else if (arg === "--run-started-at") { options.runStartedAt = argv[++index]; }
    else if (arg === "--attempted-at") { options.attemptedAt = argv[++index]; }
    else if (arg === "--run-id") { options.runId = argv[++index]; }
    else if (arg === "--now") { options.now = argv[++index]; }
    else if (arg === "--dry-run") { options.dryRun = true; }
    else if (arg === "--help") {
      console.log("Usage: node scripts/run-all.mjs --run-date YYYY-MM-DD [--run-started-at ISO] [--attempted-at ISO] [--run-id ID] [--dry-run]");
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!isIsoDate(options.runDate)) throw new Error(`--run-date must be a real YYYY-MM-DD date: ${options.runDate}`);
  const started = new Date(options.runStartedAt);
  if (Number.isNaN(started.getTime())) throw new Error(`Invalid --run-started-at value: ${options.runStartedAt}`);
  options.runStartedAt = started.toISOString();
  options.attemptedAt = new Date(options.attemptedAt || options.runStartedAt);
  if (Number.isNaN(options.attemptedAt.getTime())) throw new Error(`Invalid --attempted-at value: ${options.attemptedAt}`);
  options.attemptedAt = options.attemptedAt.toISOString();
  options.now = new Date(options.now || options.runStartedAt);
  if (Number.isNaN(options.now.getTime())) throw new Error(`Invalid --now value: ${options.now}`);
  options.runId ||= `local-run-all-${options.runDate}`;
  return options;
}

function stagePlan(runDate, startedAt) {
  const context = resolveStage(startedAt);
  const currentDate = kstDate(new Date(startedAt));
  const isHistorical = runDate < currentDate;
  if (isHistorical) {
    return STAGES.map((stage) => ({ stage, status: "planned", reason: "historical target uses public historical crawl; forecast remains unsupported without pre-open history." }));
  }
  const availability = {
    "update-results": context.phase === "before-open",
    analysis: context.phase === "before-open",
    forecast: context.phase === "before-open",
    "open-settlement": context.phase !== "before-open",
    "close-settlement": context.phase === "after-close",
  };
  return STAGES.map((stage) => ({
    stage,
    status: availability[stage] ? "planned" : "pending",
    reason: availability[stage] ? "live Naver stage will be attempted." : "source for this stage is not available at the selected run time; no value will be synthesized.",
  }));
}

function overallStatus(results) {
  const statuses = results.map((result) => result.status);
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.some((status) => status !== "ready")) return "partial";
  return "ready";
}

async function verifyFinalState(runDate, runId, sourceTimestamp) {
  const paths = STAGES.map((stage) => `data/runs/${runDate}/${stage === "update-results" ? "0700" : stage === "analysis" ? "0800" : stage === "forecast" ? "0820" : stage === "open-settlement" ? "0900" : "1530"}.json`);
  const snapshots = [];
  for (const path of paths) {
    try {
      await access(path);
      snapshots.push(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      return { status: "blocked", message: `Final consistency check could not read ${path}: ${error.message}` };
    }
  }
  const metadataConsistent = snapshots.every((snapshot) => (
    snapshot.meta?.run_date === runDate
    && snapshot.meta?.run_id === runId
    && snapshot.meta?.source?.retrieved_at === sourceTimestamp
  ));
  if (!metadataConsistent) {
    return { status: "blocked", message: "Stage metadata did not preserve one run_id, run_date, and source timestamp across all five stages." };
  }
  const latest = JSON.parse(await readFile("data/latest-snapshot.json", "utf8"));
  if (JSON.stringify(latest) !== JSON.stringify(snapshots.at(-1))) {
    return { status: "blocked", message: "latest-snapshot.json is not identical to the final close-settlement stage file." };
  }
  return { status: "ready", message: "Final stage files and latest snapshot are consistent." };
}

async function appendSummary(summary) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    "### KOSPI run all now",
    `- overall: \`${summary.status}\``,
    `- run date: \`${summary.runDate}\``,
    `- run id: \`${summary.runId}\``,
    `- source timestamp: \`${summary.sourceTimestamp}\``,
    "",
    "| order | stage | status | message |",
    "| ---: | --- | --- | --- |",
    ...summary.stages.map((stage, index) => `| ${index + 1} | \`${stage.stage}\` | \`${stage.status}\` | ${(stage.message || stage.reason || "").replaceAll("|", "\\|").replaceAll("\n", " ")} |`),
    "",
  ];
  await appendFile(summaryPath, lines.join("\n"), "utf8");
}

export async function runAll(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options) return { help: true };
  const market = await checkMarketDate(options.runDate);
  const currentDate = kstDate(options.now);
  const base = {
    runDate: options.runDate,
    runId: options.runId,
    sourceTimestamp: options.attemptedAt,
    dryRun: options.dryRun,
  };

  if (options.runDate > currentDate) {
    const summary = { ...base, status: "blocked", reason: "future_date", stages: STAGES.map((stage) => ({ stage, status: "blocked", reason: "Future run dates are blocked; no snapshot is written." })) };
    await appendSummary(summary);
    return summary;
  }
  if (market.status !== "run") {
    const status = market.status === "skip" ? "blocked" : "blocked";
    const summary = { ...base, status, reason: market.reason, market, stages: STAGES.map((stage) => ({ stage, status, reason: market.message })) };
    await appendSummary(summary);
    return summary;
  }
  if (options.dryRun) {
    const summary = { ...base, status: "ready", mode: "plan_only", stages: stagePlan(options.runDate, options.runStartedAt) };
    await appendSummary(summary);
    return summary;
  }

  const previousEnv = {
    KOSPI_PROVIDER: process.env.KOSPI_PROVIDER,
    KOSPI_RUN_DATE: process.env.KOSPI_RUN_DATE,
    KOSPI_RUN_STARTED_AT: process.env.KOSPI_RUN_STARTED_AT,
    KOSPI_RUN_ID: process.env.KOSPI_RUN_ID,
    KOSPI_STABLE_SNAPSHOT: process.env.KOSPI_STABLE_SNAPSHOT,
  };
  Object.assign(process.env, {
    KOSPI_PROVIDER: "naver-crawl",
    KOSPI_RUN_DATE: options.runDate,
    KOSPI_RUN_STARTED_AT: options.runStartedAt,
    KOSPI_RUN_ID: options.runId,
    KOSPI_STABLE_SNAPSHOT: "1",
  });
  const stages = [];
  try {
    for (const stage of STAGES) {
      try {
        const result = await runStage([
          "--mode", stage,
          "--provider", "naver-crawl",
          "--run-date", options.runDate,
          "--run-started-at", options.runStartedAt,
          "--attempted-at", options.attemptedAt,
        ]);
        stages.push({ stage, status: result.status, message: result.message, stageFile: result.stageFile });
      } catch (error) {
        stages.push({ stage, status: "blocked", message: `Stage execution failed: ${error.message}` });
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const consistency = await verifyFinalState(options.runDate, options.runId, options.attemptedAt);
  if (consistency.status !== "ready") stages.push({ stage: "consistency", status: consistency.status, message: consistency.message });
  const summary = { ...base, status: overallStatus(stages), stages };
  await appendSummary(summary);
  return summary;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runAll().then(async (summary) => {
    if (summary.help) return;
    if (process.env.GITHUB_OUTPUT) {
      await writeFile(process.env.GITHUB_OUTPUT, [
        `overall_status=${summary.status}`,
        `run_date=${summary.runDate}`,
        `run_id=${summary.runId}`,
        `source_timestamp=${summary.sourceTimestamp}`,
      ].join("\n") + "\n", "utf8");
    }
    console.log(JSON.stringify(summary));
    if (!summary.dryRun && summary.status !== "ready") process.exitCode = 1;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
