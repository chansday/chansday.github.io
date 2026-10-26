import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = join(PROJECT_ROOT, "data", "date-index.json");
const SOURCE_CONFIG = {
  provider: { root: join(PROJECT_ROOT, "data", "runs"), stage: "1530" },
  "historical-test": { root: join(PROJECT_ROOT, "data", "runs", "historical-test"), stage: "1530" },
  fixture: { root: join(PROJECT_ROOT, "data", "fixtures"), fileMode: true },
  replay: { root: join(PROJECT_ROOT, "data", "replays"), fileMode: true },
  "backfill-test": { root: join(PROJECT_ROOT, "data", "backfill-test"), fileMode: true },
};

function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value); }

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function datesForSource(config) {
  const names = await readdir(config.root, { withFileTypes: true });
  if (config.fileMode) return names.filter((entry) => entry.isFile() && isDate(entry.name.replace(/\.json$/, ""))).map((entry) => entry.name.replace(/\.json$/, ""));
  const dates = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !isDate(entry.name)) continue;
    if (await isFile(join(config.root, entry.name, `${config.stage}.json`))) dates.push(entry.name);
  }
  return dates;
}

export async function buildDateIndex({ output = DEFAULT_OUTPUT } = {}) {
  const availableDates = {};
  for (const [mode, config] of Object.entries(SOURCE_CONFIG)) availableDates[mode] = (await datesForSource(config)).sort();
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
