import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { checkMarketDate, kstDate } from "./market-calendar.mjs";
import { resolveStage } from "./run-context.mjs";
import { run as runStage } from "./update-results.mjs";
import { runDailyBaseline } from "./daily-baseline-run.mjs";
import { runPostCloseEvaluation } from "./post-close-evaluation.mjs";
import { createProgressLog, reconstructDate } from "./reconstruct-day.mjs";

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

const STAGES = Object.freeze([
  "update-results",
  "analysis",
  "forecast",
  "open-settlement",
  "close-settlement",
]);
const KNOWN_STAGE_STATUSES = new Set(["blocked", "degraded", "partial", "ready", "no_data", "pending", "planned"]);

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

  const eligibleStages = new Set(["update-results", "analysis", "forecast"]);
  if (time >= "09:00:00") eligibleStages.add("open-settlement");
  if (time >= "15:30:00") eligibleStages.add("close-settlement");

  return STAGES.map((stage) => {
    const eligible = eligibleStages.has(stage);
    let reason = "live source is eligible at the actual run-start time.";
    if (!eligible && stage === "open-settlement") {
      reason = "open-settlement is pending until 09:00 KST; no value is synthesized before the open.";
    } else if (!eligible && stage === "close-settlement") {
      reason = "close-settlement is pending until 15:30 KST; no close command is called early.";
    }
    return { stage, status: eligible ? "planned" : "pending", eligible, policy: "current", reason };
  });
}

function stageLabel(result) {
  return `${result?.stage || "unknown"}=${result?.status || "missing"}`;
}

function isPostCloseCurrentRun(runDate, runStartedAt) {
  const context = resolveStage(runStartedAt);
  return kstDate(new Date(runStartedAt)) === runDate && context.stage === "close-settlement";
}

function overallDecision(results) {
  const invalid = results.filter((result) => !result || typeof result.status !== "string" || !KNOWN_STAGE_STATUSES.has(result.status));
  const executed = results.filter((result) => result?.executed || result?.stage === "consistency");
  const pending = results.filter((result) => result?.status === "pending" && !result?.executed);
  const unexpectedNonReady = results.filter((result) => !result?.executed
    && !["pending", "planned", "ready"].includes(result?.status));
  const executedNonReady = executed.filter((result) => result.status !== "ready");
  const executedStagesReady = executedNonReady.length === 0 && invalid.length === 0;

  if (invalid.length > 0) {
    return {
      status: "blocked",
      reason: `Unknown or missing stage status: ${invalid.map(stageLabel).join(", ")}.`,
      executedStagesReady: false,
      pendingOnlyPartial: false,
      commitAllowed: false,
    };
  }
  if (unexpectedNonReady.length > 0) {
    return {
      status: "blocked",
      reason: `Non-executed stage has an invalid non-ready status: ${unexpectedNonReady.map(stageLabel).join(", ")}.`,
      executedStagesReady: false,
      pendingOnlyPartial: false,
      commitAllowed: false,
    };
  }
  if (executed.some((result) => result.status === "blocked")) {
    return {
      status: "blocked",
      reason: `Executed stage(s) returned blocked: ${executedNonReady.map(stageLabel).join(", ")}.`,
      executedStagesReady: false,
      pendingOnlyPartial: false,
      commitAllowed: false,
    };
  }
  if (!executedStagesReady) {
    return {
      status: "degraded",
      reason: `Executed stage(s) were not ready: ${executedNonReady.map(stageLabel).join(", ")}.`,
      executedStagesReady: false,
      pendingOnlyPartial: false,
      commitAllowed: false,
    };
  }
  if (pending.length > 0) {
    return {
      status: "partial",
      reason: "Only pending stage(s) remain; every executed stage returned ready.",
      executedStagesReady: true,
      pendingOnlyPartial: true,
      commitAllowed: true,
    };
  }
  return {
    status: "ready",
    reason: "All eligible stages returned ready.",
    executedStagesReady: true,
    pendingOnlyPartial: false,
    commitAllowed: true,
  };
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
    `- operating overall: \`${summary.status}\``,
    `- overall reason: ${summary.overallReason || summary.reason || "not provided"}`,
    `- run date: \`${summary.runDate}\``,
    `- run id: \`${summary.runId}\``,
    `- source timestamp: \`${summary.sourceTimestamp}\``,
    `- source warnings: ${summary.stages.filter((stage) => stage.sourceWarning).map((stage) => `${stage.stage}: ${stage.sourceWarning}`).join(" | ") || "none"}`,
    `- executed stages ready: \`${summary.executedStagesReady}\``,
    `- pending-only partial: \`${summary.pendingOnlyPartial}\``,
    `- commit allowed: \`${summary.commitAllowed}\``,
    `- isolated daily experiment: \`${summary.experiment?.status || "not_run"}\` (${summary.experiment?.reason || "not run"}); status record saved: ${summary.experiment?.statusSaved === true}`,
    `- post-close retrospective: \`${summary.retrospective?.status || "not_run"}\` (${summary.retrospective?.message || "not applicable"})`,
    "",
    "| order | stage | status | execution | reason |",
    "| ---: | --- | --- | --- | --- |",
    ...summary.stages.map((stage, index) => `| ${index + 1} | \`${stage.stage}\` | \`${stage.status}\` | \`${stage.executed ? "called" : stage.eligible === false ? "skipped" : "planned"}\` | ${(stage.message || stage.reason || "").replaceAll("|", "\\|").replaceAll("\n", " ")} |`),
    "",
  ];
  await appendFile(summaryPath, lines.join("\n"), "utf8");
}

export async function runAll(argv = process.argv.slice(2), { stageRunner = runStage, consistencyChecker = verifyFinalState, experimentRunner = stageRunner === runStage ? runDailyBaseline : null, retrospectiveRunner = stageRunner === runStage ? runPostCloseEvaluation : null, reconstructor = stageRunner === runStage ? reconstructDate : null } = {}) {
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
    const summary = { ...base, status: "blocked", reason: "future_date", overallReason: "future_date: future run dates are blocked; no collection or snapshot write is allowed.", executedStagesReady: false, pendingOnlyPartial: false, commitAllowed: false, collection: "skipped", stages: STAGES.map((stage) => ({ stage, status: "blocked", eligible: false, executed: false, reason: "Future run dates are blocked; no collection or snapshot write is allowed." })) };
    await appendSummary(summary);
    return summary;
  }
  if (market.status !== "run") {
    const summary = { ...base, status: "blocked", reason: market.reason, overallReason: `${market.reason}: ${market.message} No collection or snapshot write is allowed.`, executedStagesReady: false, pendingOnlyPartial: false, commitAllowed: false, policy: "market_closed", marketState: "market_closed", collection: "skipped", market, stages: STAGES.map((stage) => ({ stage, status: "blocked", eligible: false, executed: false, reason: `market_closed: ${market.message} No collection or snapshot write is allowed.` })) };
    await appendSummary(summary);
    return summary;
  }
  const plan = stagePlan(options.runDate, options.runStartedAt);
  if (options.dryRun) {
    const decision = overallDecision(plan);
    const summary = { ...base, ...decision, mode: "plan_only", stages: plan };
    await appendSummary(summary);
    return summary;
  }

  // A previous trading day without a stored close settlement is rebuilt from
  // daily candles: every stage file is (re)written as if analysed that day.
  if (options.runDate < currentDate && reconstructor && !(await exists(`data/runs/${options.runDate}/1530.json`))) {
    let result;
    try { result = await reconstructor({ runDate: options.runDate, runId: options.runId }); }
    catch (error) { result = { status: "blocked", reason: `Reconstruction failed: ${error.message}`, wrote: [] }; }
    const ready = result.status === "ready";
    const retrospective = { ...(result.retrospective || { status: "not_run" }), historical: true, sourceRunId: options.runId, message: result.retrospective?.status === "ready" ? `${result.retrospective.evaluated}/${result.retrospective.total} rows evaluated from the reconstructed settlement` : result.retrospective?.reason || "not run" };
    const summary = { ...base, status: ready ? "ready" : result.status === "blocked" ? "blocked" : "degraded", reason: result.reason, executedStagesReady: ready, pendingOnlyPartial: false, commitAllowed: ready, reconstructed: true,
      stages: [{ stage: "reconstruction", status: ready ? "ready" : result.status, executed: true, message: result.reason }], experiment: { status: "not_run", saved: false }, retrospective };
    await appendSummary(summary);
    return summary;
  }

  // A previous day's validated settlement is an observed input, not a fresh
  // market run. Preserve its stage files and attach a separate evaluation.
  if (options.runDate < currentDate && retrospectiveRunner) {
    let retrospective;
    try {
      const stageFile = `data/runs/${options.runDate}/1530.json`;
      const settled = JSON.parse(await readFile(stageFile, "utf8"));
      const sourceRunId = settled.meta?.run_id;
      if (settled.status !== "ready" || settled.provider?.id !== "naver-crawl" || settled.asOfDate !== options.runDate || settled.meta?.run_date !== options.runDate || settled.meta?.run_stage !== "close-settlement" || settled.meta?.source?.source_date !== options.runDate || !/^[A-Za-z0-9._-]+$/.test(sourceRunId || "")) throw new Error("Stored settlement is not a ready, same-date observed Naver run");
      const result = await retrospectiveRunner({ runDate: options.runDate, runId: sourceRunId, stageFile });
      if (result.status !== "ready") throw new Error("Retrospective evaluation did not return ready");
      retrospective = { ...result, historical: true, sourceRunId, message: `${result.evaluated}/${result.total} rows evaluated from the existing settlement` };
    } catch (error) {
      retrospective = { status: "blocked", historical: true, message: `Historical retrospective failed: ${error.message}` };
    }
    const ready = retrospective.status === "ready";
    const summary = { ...base, status: ready ? "ready" : "blocked", reason: retrospective.message, executedStagesReady: ready, pendingOnlyPartial: false, commitAllowed: ready, stages: [{ stage: "retrospective", status: retrospective.status, executed: true, message: retrospective.message }], experiment: { status: "not_run", saved: false }, retrospective };
    await appendSummary(summary);
    return summary;
  }

  const experimentPostClose = isPostCloseCurrentRun(options.runDate, options.runStartedAt);
  let experiment = { status: "not_run", saved: false, notApplicable: false, postClose: experimentPostClose };
  if (experimentRunner && !options.dryRun) {
    try {
      const result = await experimentRunner({ targetDate: options.runDate, runStartedAt: options.runStartedAt });
      experiment = { ...result, notApplicable: result?.notApplicable === true, postClose: experimentPostClose };
    } catch (error) { experiment = { status: "failed", saved: false, notApplicable: false, postClose: experimentPostClose, reason: error.message }; }
  }

  const previousEnv = {
    KOSPI_PROVIDER: process.env.KOSPI_PROVIDER,
    KOSPI_RUN_DATE: process.env.KOSPI_RUN_DATE,
    KOSPI_RUN_STARTED_AT: process.env.KOSPI_RUN_STARTED_AT,
    KOSPI_RUN_ID: process.env.KOSPI_RUN_ID,
    KOSPI_STABLE_SNAPSHOT: process.env.KOSPI_STABLE_SNAPSHOT,
    KOSPI_MANUAL_RUN_ALL: process.env.KOSPI_MANUAL_RUN_ALL,
  };
  Object.assign(process.env, {
    KOSPI_PROVIDER: "naver-crawl",
    KOSPI_RUN_DATE: options.runDate,
    KOSPI_RUN_STARTED_AT: options.runStartedAt,
    KOSPI_RUN_ID: options.runId,
    KOSPI_STABLE_SNAPSHOT: "1",
    KOSPI_MANUAL_RUN_ALL: "1",
  });
  const stageResults = new Map();
  const executedStages = [];
  const log = createProgressLog({ label: "run-all" });
  log(`${options.runDate} 단계 실행 시작 · 대상 ${plan.filter((entry) => entry.eligible).map((entry) => entry.stage).join(" → ") || "없음"}`);
  try {
    for (const planned of plan.filter((entry) => entry.eligible)) {
      const stage = planned.stage;
      const stageStarted = Date.now();
      log(`${stage} 시작`);
      try {
        const result = await stageRunner([
          "--mode", stage,
          "--provider", "naver-crawl",
          "--run-date", options.runDate,
          "--run-started-at", options.runStartedAt,
          "--attempted-at", options.attemptedAt,
        ]);
        const stageResult = { stage, status: result.status, executed: true, eligible: true, reason: planned.reason, message: result.message, sourceWarning: result.sourceWarning || null, stageFile: result.stageFile };
        stageResults.set(stage, stageResult);
        executedStages.push(stageResult);
        log(`${stage} 완료 (${((Date.now() - stageStarted) / 1000).toFixed(1)}s) · 상태 ${result.status}`);
      } catch (error) {
        log(`${stage} 실패 (${((Date.now() - stageStarted) / 1000).toFixed(1)}s) · ${error.message}`);
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
  let consistency;
  try {
    consistency = await consistencyChecker(options.runDate, options.runId, options.attemptedAt, executedStages);
    if (!consistency || typeof consistency.status !== "string" || !KNOWN_STAGE_STATUSES.has(consistency.status)) {
      consistency = { status: "blocked", message: "Final consistency check returned an empty or unknown status." };
    }
  } catch (error) {
    consistency = { status: "blocked", message: `Final consistency check failed: ${error.message}` };
  }
  if (consistency.status !== "ready") stages.push({ stage: "consistency", status: consistency.status, executed: true, message: consistency.message });
  let retrospective = { status: "not_run" };
  if (experimentPostClose && retrospectiveRunner && overallDecision(stages).status === "ready") {
    try {
      retrospective = await retrospectiveRunner({ runDate: options.runDate, runId: options.runId, stageFile: stageResults.get("close-settlement")?.stageFile });
      if (retrospective.status !== "ready") throw new Error("Retrospective evaluation did not return ready");
      retrospective.message = `${retrospective.evaluated}/${retrospective.total} rows evaluated; calculated after close`;
    } catch (error) {
      retrospective = { status: "blocked", message: `Post-close retrospective failed: ${error.message}` };
      stages.push({ stage: "retrospective", status: "blocked", executed: true, message: retrospective.message });
    }
  }
  const summary = { ...base, ...overallDecision(stages), stages, experiment, retrospective };
  await appendSummary(summary);
  return summary;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runAll().then(async (summary) => {
    if (summary.help) return;
    if (process.env.GITHUB_OUTPUT) {
      const outputReason = String(summary.overallReason || summary.reason || "").replaceAll("\r", "").replaceAll("\n", " ");
      await writeFile(process.env.GITHUB_OUTPUT, [
        `overall_status=${summary.status}`,
        `overall_reason=${outputReason}`,
        `executed_stages_ready=${summary.executedStagesReady}`,
        `pending_only_partial=${summary.pendingOnlyPartial}`,
        `commit_allowed=${summary.commitAllowed}`,
        `run_date=${summary.runDate}`,
        `run_id=${summary.runId}`,
        `source_timestamp=${summary.sourceTimestamp}`,
        `experiment_saved=${summary.experiment?.saved === true}`,
        `experiment_phase=${summary.experiment?.phase || ""}`,
        `experiment_candidates=${summary.experiment?.candidatePhases?.join(",") || ""}`,
        `experiment_candidate=${summary.experiment?.candidate === true}`,
        `experiment_status=${summary.experiment?.status || "not_run"}`,
        `experiment_reason=${String(summary.experiment?.reason || "").replaceAll("\\r", "").replaceAll("\\n", " ")}`,
        `experiment_not_applicable=${summary.experiment?.notApplicable === true}`,
        `experiment_post_close=${summary.experiment?.postClose === true}`,
        `experiment_status_saved=${summary.experiment?.statusSaved === true}`,
        `experiment_status_hash=${summary.experiment?.statusHash || ""}`,
        `retrospective_status=${summary.retrospective?.status || "not_run"}`,
        `retrospective_historical=${summary.retrospective?.historical === true}`,
        `retrospective_source_run_id=${summary.retrospective?.sourceRunId || summary.runId}`,
      ].join("\n") + "\n", "utf8");
    }
    console.log(JSON.stringify(summary));
    if (!summary.dryRun && ["blocked", "degraded"].includes(summary.status)) process.exitCode = 1;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
