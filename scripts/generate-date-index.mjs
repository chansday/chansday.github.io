import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = join(PROJECT_ROOT, "data", "date-index.json");
// An isolated root (tests, KOSPI_DATA_ROOT dry-runs) may lack the test-only
// folders; the repository root must have them all.
const sourceConfig = (base) => {
  const optional = resolve(base) !== PROJECT_ROOT;
  return {
    provider: { root: join(base, "data", "runs"), stage: "1530", optional },
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
    if (await isFile(join(config.root, entry.name, `${config.stage}.json`))) dates.push(entry.name);
  }
  return dates;
}

// `root` lets an isolated data root (KOSPI_DATA_ROOT, tests) index its own files.
export async function buildDateIndex({ root = PROJECT_ROOT, output = root === PROJECT_ROOT ? DEFAULT_OUTPUT : join(root, "data", "date-index.json") } = {}) {
  const availableDates = {};
  for (const [mode, config] of Object.entries(sourceConfig(root))) availableDates[mode] = (await datesForSource(config)).sort();
  const index = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    sourceContract: "Each date is listed only when the mode-specific snapshot file exists at its configured stage.",
    stage: "1530",
    availableDates,
  };
  await writeFile(output, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputArg = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length) || DEFAULT_OUTPUT;
  await buildDateIndex({ output: resolve(outputArg) });
  console.log(`Wrote ${resolve(outputArg)}`);
}
