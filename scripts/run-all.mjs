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
  const time = `${context.kst.hour}:${context.kst.minute}:${context.kst.second}`;
  const isHistorical = runDate < currentDate;

  if (isHistorical) {
    return STAGES.map((stage) => ({
      stage,
      status: "planned",
      eligible: true,
      policy: "historical",
      reason: "historical policy: public historical source is allowed; unavailable pre-open history remains no_data rather than being reconstructed.",
    }));
  }

  const eligibleStages = time < "09:00:00"
    ? new Set(["update-results", "analysis", "forecast"])
    : time < "15:30:00"
      ? new Set(["update-results", "analysis", "open-settlement"])
      : new Set(["update-results", "analysis", "open-settlement", "close-settlement"]);

  return STAGES.map((stage) => {
    const eligible = eligibleStages.has(stage);
    let reason = "live source is eligible at the actual run-start time.";
    if (!eligible && stage === "forecast") {
      reason = time < "09:00:00"
        ? "forecast is eligible before 09:00 KST."
        : "forecast is late at the actual run-start time; it is pending and is not collected retroactively.";
    } else if (!eligible && stage === "open-settlement") {
      reason = "open-settlement is pending until 09:00 KST; no value is synthesized before the open.";
    } else if (!eligible && stage === "close-settlement") {
      reason = "close-settlement is pending until 15:30 KST; no close command is called early.";
    }
    return { stage, status: eligible ? "planned" : "pending", eligible, policy: "current", reason };
  });
}

function overallStatus(results) {
  const executed = results.filter((result) => result.executed || result.stage === "consistency");
  if (executed.some((result) => result.status === "blocked")) return "blocked";
  if (executed.some((result) => result.status === "degraded")) return "degraded";
  if (results.some((result) => result.status === "pending")) return "partial";
  if (executed.some((result) => ["no_data", "partial"].includes(result.status))) return "partial";
  return "ready";
}

async function verifyFinalState(runDate, runId, sourceTimestamp, executedStages) {
  if (executedStages.length === 0) {
    return { status: "ready", message: "No eligible stage ran; consistency check was skipped." };
  }
  const snapshots = [];
  for (const stageResult of executedStages) {
    const path = stageResult.stageFile;
    if (!path) {
      return { status: "blocked", message: `Final consistency check has no stage file for executed stage ${stageResult.stage}.` };
    }
    try {
      await access(path);
      snapshots.push(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      return { status: "blocked", message: `Final consistency check could not read ${path}: ${error.message}` };
    }
  }
  const metadataConsistent = snapshots.every((snapshot) => {
    const sourceRetrievedAt = snapshot.meta?.source?.retrieved_at;
    return snapshot.meta?.run_date === runDate
      && snapshot.meta?.run_id === runId
      && snapshot.meta?.lastAttemptAt === sourceTimestamp
      && (!sourceRetrievedAt || !Number.isNaN(Date.parse(sourceRetrievedAt)))
      && (!snapshot.meta?.source?.run_id || snapshot.meta.source.run_id === runId);
  });
  if (!metadataConsistent) {
    return { status: "blocked", message: "Executed stage metadata did not preserve one run_id, run_date, and run-start timestamp." };
  }
  const latest = JSON.parse(await readFile("data/latest-snapshot.json", "utf8"));
  if (JSON.stringify(latest) !== JSON.stringify(snapshots.at(-1))) {
    return { status: "blocked", message: "latest-snapshot.json is not identical to the last eligible executed stage file." };
  }
  return { status: "ready", message: "Executed stage files and latest snapshot are consistent." };
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
    "| order | stage | status | execution | reason |",
    "| ---: | --- | --- | --- | --- |",
    ...summary.stages.map((stage, index) => `| ${index + 1} | \`${stage.stage}\` | \`${stage.status}\` | \`${stage.executed ? "called" : stage.eligible === false ? "skipped" : "planned"}\` | ${(stage.message || stage.reason || "").replaceAll("|", "\\|").replaceAll("\n", " ")} |`),
    "",
  ];
  await appendFile(summaryPath, lines.join("\n"), "utf8");
}

export async function runAll(argv = process.argv.slice(2), { stageRunner = runStage, consistencyChecker = verifyFinalState } = {}) {
  const options = parseArgs(argv);
  if (!options) return { help: true };
  const market = await checkMarketDate(options.runDate);
  const currentDate = kstDate(new Date(options.runStartedAt));
  const base = {
    runDate: options.runDate,
    runId: options.runId,
    sourceTimestamp: options.attemptedAt,
    runStartedAt: options.runStartedAt,
    currentKstDate: currentDate,
    dryRun: options.dryRun,
  };

  if (options.runDate > currentDate) {
    const summary = { ...base, status: "blocked", reason: "future_date", collection: "skipped", stages: STAGES.map((stage) => ({ stage, status: "blocked", eligible: false, executed: false, reason: "Future run dates are blocked; no collection or snapshot write is allowed." })) };
    await appendSummary(summary);
    return summary;
  }
  if (market.status !== "run") {
    const summary = { ...base, status: "blocked", reason: market.reason, policy: "market_closed", marketState: "market_closed", collection: "skipped", market, stages: STAGES.map((stage) => ({ stage, status: "blocked", eligible: false, executed: false, reason: `market_closed: ${market.message} No collection or snapshot write is allowed.` })) };
    await appendSummary(summary);
    return summary;
  }
  const plan = stagePlan(options.runDate, options.runStartedAt);
  if (options.dryRun) {
    const summary = { ...base, status: overallStatus(plan), mode: "plan_only", stages: plan };
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
  const stageResults = new Map();
  const executedStages = [];
  try {
    for (const planned of plan.filter((entry) => entry.eligible)) {
      const stage = planned.stage;
      try {
        const result = await stageRunner([
          "--mode", stage,
          "--provider", "naver-crawl",
          "--run-date", options.runDate,
          "--run-started-at", options.runStartedAt,
          "--attempted-at", options.attemptedAt,
        ]);
        const stageResult = { stage, status: result.status, executed: true, eligible: true, reason: planned.reason, message: result.message, stageFile: result.stageFile };
        stageResults.set(stage, stageResult);
        executedStages.push(stageResult);
      } catch (error) {
        const stageResult = { stage, status: "blocked", executed: true, eligible: true, reason: planned.reason, message: `Stage execution failed: ${error.message}`, stageFile: null };
        stageResults.set(stage, stageResult);
        executedStages.push(stageResult);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const stages = plan.map((planned) => stageResults.get(planned.stage) || {
    ...planned,
    executed: false,
    message: planned.reason,
  });
  const consistency = await consistencyChecker(options.runDate, options.runId, options.attemptedAt, executedStages);
  if (consistency.status !== "ready") stages.push({ stage: "consistency", status: consistency.status, executed: true, message: consistency.message });
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
    if (!summary.dryRun && ["blocked", "degraded"].includes(summary.status)) process.exitCode = 1;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
