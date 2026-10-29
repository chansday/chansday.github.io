import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = join(PROJECT_ROOT, "data", "date-index.json");
// Newest first: the latest stage file present for a date is the one shown.
export const PROVIDER_STAGES = Object.freeze(["1530", "0900", "0820", "0800", "0700"]);
// An isolated root (tests, KOSPI_DATA_ROOT dry-runs) may lack the test-only
// folders; the repository root must have them all.
const sourceConfig = (base) => {
  const optional = resolve(base) !== PROJECT_ROOT;
  return {
    // Operating dates are listed as soon as any stage file exists, so an
    // intraday run is visible before close-settlement writes 1530.json.
    provider: { root: join(base, "data", "runs"), stage: "1530", stages: PROVIDER_STAGES, optional },
    "historical-test": { root: join(base, "data", "runs", "historical-test"), stage: "1530", optional },
    fixture: { root: join(base, "data", "fixtures"), fileMode: true, optional },
    replay: { root: join(base, "data", "replays"), fileMode: true, optional },
    "backfill-test": { root: join(base, "data", "backfill-test"), fileMode: true, optional },
  };
};

function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value); }

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function datesForSource(config) {
  let names;
  try { names = await readdir(config.root, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT" && config.optional) return []; throw error; }
  if (config.fileMode) return names.filter((entry) => entry.isFile() && isDate(entry.name.replace(/\.json$/, ""))).map((entry) => entry.name.replace(/\.json$/, ""));
  const dates = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !isDate(entry.name)) continue;
    for (const stage of config.stages || [config.stage]) {
      if (await isFile(join(config.root, entry.name, `${stage}.json`))) { dates.push({ date: entry.name, stage }); break; }
    }
  }
  return dates;
}

// `root` lets an isolated data root (KOSPI_DATA_ROOT, tests) index its own files.
export async function buildDateIndex({ root = PROJECT_ROOT, output = root === PROJECT_ROOT ? DEFAULT_OUTPUT : join(root, "data", "date-index.json") } = {}) {
  const availableDates = {};
  const latestStages = {};
  for (const [mode, config] of Object.entries(sourceConfig(root))) {
    const found = await datesForSource(config);
    availableDates[mode] = found.map((item) => typeof item === "string" ? item : item.date).sort();
    if (config.stages) latestStages[mode] = Object.fromEntries(found.map((item) => [item.date, item.stage]).sort());
  }
  const index = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    sourceContract: "Each date is listed only when a mode-specific snapshot file exists; operating dates use the latest stage file present (latestStages).",
    stage: "1530",
    availableDates,
    latestStages,
  };
  await writeFile(output, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputArg = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length) || DEFAULT_OUTPUT;
  await buildDateIndex({ output: resolve(outputArg) });
  console.log(`Wrote ${resolve(outputArg)}`);
}
