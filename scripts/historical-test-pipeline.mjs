import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isSnapshot } from "../providers/provider-adapter.js";
import { buildEvaluationSummary } from "../providers/evaluation-contract.js";

const SUPPORTED_DATES = ["2026-10-22", "2026-10-23"];
const STAGES = [
  ["0700", "previousResult"],
  ["0800", "analysis"],
  ["0820", "forecast"],
  ["0900", "openSettlement"],
  ["1530", "closeSettlement"],
];
const ACTUAL_FIELDS = ["actual_open", "actual_close", "actual_return", "session_return", "actual_volume", "error"];

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseArgs(argv) {
  const options = {
    dates: SUPPORTED_DATES,
    sourceRoot: resolve("data", "historical-test"),
    outputRoot: resolve("data", "runs", "historical-test"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") options.dates = [argv[++index]];
    else if (arg === "--source-root") options.sourceRoot = resolve(argv[++index]);
    else if (arg === "--output-root") options.outputRoot = resolve(argv[++index]);
    else if (arg === "--help") {
      console.log("Usage: node scripts/historical-test-pipeline.mjs [--date YYYY-MM-DD] [--source-root path] [--output-root path]");
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const date of options.dates) {
    if (!SUPPORTED_DATES.includes(date)) throw new Error(`Unsupported historical-test date: ${date}`);
  }
  return options;
}

function stagePipeline(source, currentStageIndex) {
  return Object.fromEntries(STAGES.map(([stage, key], index) => [key, {
    ...(source.pipeline?.[key] || {}),
    status: index <= currentStageIndex ? "ready" : "pending",
    attemptedAt: source.publishedAt,
    provider_id: "historical-test",
    message: `Historical-test stage ${stage}; retrospective data only.`,
  }]));
}

function stageRows(sourceRows, currentStageIndex) {
  return sourceRows.map((sourceRow) => {
    const row = { ...sourceRow };
    if (currentStageIndex < 3) {
      for (const field of ACTUAL_FIELDS) row[field] = null;
    } else if (currentStageIndex === 3) {
      row.actual_close = null;
      row.session_return = null;
      row.actual_volume = null;
      row.actual_return = typeof row.actual_open === "number" && typeof row.prior_close === "number" && row.prior_close > 0
        ? round((row.actual_open / row.prior_close - 1) * 100)
        : null;
      row.error = typeof row.actual_return === "number" && typeof row.expected_return === "number"
        ? round(row.actual_return - row.expected_return)
        : null;
    } else {
      row.actual_return = typeof row.actual_open === "number" && typeof row.prior_close === "number" && row.prior_close > 0
        ? round((row.actual_open / row.prior_close - 1) * 100)
        : null;
      row.session_return = typeof row.actual_open === "number" && typeof row.actual_close === "number" && row.actual_open > 0
        ? round((row.actual_close / row.actual_open - 1) * 100)
        : null;
      row.error = typeof row.actual_return === "number" && typeof row.expected_return === "number"
        ? round(row.actual_return - row.expected_return)
        : null;
    }
    row.quality = currentStageIndex < 3 ? "historical_baseline_public_daily_pending_settlement" : currentStageIndex === 3 ? "historical_baseline_public_daily_open_settled" : "historical_baseline_public_daily_settled";
    row.status = "valid";
    return row;
  });
}

function buildStageSnapshot(source, date, stageIndex) {
  const [stage] = STAGES[stageIndex];
  const rows = stageRows(source.rows, stageIndex);
  const inputDates = source.baseline?.input_dates || [];
  return {
    ...source,
    status: "ready",
    mode: "historical_test",
    publishedAt: source.publishedAt,
    pipeline: stagePipeline(source, stageIndex),
    rows,
    evaluation: buildEvaluationSummary(rows, {
      testOnly: true,
      dataset: "historical_test",
      asOfDate: date,
      forecastStage: "0820",
      actualStage: stageIndex >= 3 ? "0900" : null,
      inputDates,
      note: "Historical-test only. This staged evaluation is isolated from operating snapshots and does not represent live forecast performance.",
    }),
    meta: {
      ...source.meta,
      test_only: true,
      historical_test: true,
      stage_test: true,
      stage,
      stage_source: `data/historical-test/${date}.json`,
      latest_snapshot_untouched: true,
      data_classification: "test_only",
      evaluation_dataset: "historical_test",
      evaluation_test_only: true,
    },
    provider: {
      ...source.provider,
      id: "historical-test",
      status: "ready",
      label: `HISTORICAL-TEST / TEST ONLY / ${date} / ${stage}`,
    },
  };
}

async function readSource(sourceRoot, date) {
  const path = resolve(sourceRoot, `${date}.json`);
  await access(path);
  const source = JSON.parse(await readFile(path, "utf8"));
  if (!isSnapshot(source) || source.mode !== "historical_test" || source.meta?.test_only !== true || source.meta?.historical_test !== true) {
    throw new Error(`Invalid historical-test source snapshot: ${path}`);
  }
  return source;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options) return { help: true };
  const written = [];
  for (const date of options.dates) {
    const source = await readSource(options.sourceRoot, date);
    for (let stageIndex = 0; stageIndex < STAGES.length; stageIndex += 1) {
      const [stage] = STAGES[stageIndex];
      const path = resolve(options.outputRoot, date, `${stage}.json`);
      const output = `${JSON.stringify(buildStageSnapshot(source, date, stageIndex), null, 2)}\n`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, output, "utf8");
      written.push(path);
    }
  }
  const summary = { mode: "historical_test", test_only: true, dates: options.dates, files: written, latest_snapshot_written: false };
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
