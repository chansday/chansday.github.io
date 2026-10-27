import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { checkMarketDate } from "./market-calendar.mjs";
import { resolveStage } from "./run-context.mjs";
import { runPostCloseEvaluation } from "./post-close-evaluation.mjs";

export async function runStagePostClose({ runDate, runStartedAt, runId, evaluator = runPostCloseEvaluation }) {
  const market = await checkMarketDate(runDate);
  if (market.status === "skip") return { status: "skipped", reason: market.reason };
  if (market.status !== "run") throw new Error(market.message);
  const context = resolveStage(runStartedAt);
  if (context.runDate !== runDate || context.phase !== "after-close") throw new Error("Post-close evaluation requires the current trading day after 15:30 KST");
  if (!/^[A-Za-z0-9._-]+$/.test(runId || "")) throw new Error("Invalid run ID");
  return evaluator({ runDate, runId, stageFile: `data/runs/${runDate}/1530.json` });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const runDate = process.env.KOSPI_RUN_DATE;
  runStagePostClose({ runDate, runStartedAt: process.env.KOSPI_RUN_STARTED_AT, runId: process.env.KOSPI_RUN_ID }).then(async (result) => {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- post-close retrospective: ${result.status}; ${result.evaluated ?? 0}/${result.total ?? 0} rows evaluated; calculated after close.\n`);
    console.log(JSON.stringify(result));
    if (result.status !== "ready" && result.status !== "skipped") process.exitCode = 1;
  }).catch((error) => { console.error(`Post-close evaluation failed: ${error.message}`); process.exitCode = 1; });
}
