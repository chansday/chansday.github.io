import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkMarketDate, kstDate } from "./market-calendar.mjs";
import { calculateRunContext } from "./run-context.mjs";

function parseArgs(argv) {
  let date = process.env.KOSPI_GUARD_DATE
    || (process.env.KOSPI_RUN_STARTED_AT ? calculateRunContext(process.env.KOSPI_RUN_STARTED_AT, { requireValue: true }).runDate : kstDate());
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--date") date = argv[++index];
    else if (argv[index] === "--help") {
      console.log("Usage: node scripts/market-session-guard.mjs [--date YYYY-MM-DD]");
      return null;
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return date;
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }
}

export async function run(argv = process.argv.slice(2)) {
  const date = parseArgs(argv);
  if (!date) return { help: true };
  const result = await checkMarketDate(date, { calendarPath: process.env.KOSPI_MARKET_CALENDAR_PATH });
  setOutput("should_run", result.status === "run" ? "true" : "false");
  setOutput("market_date", result.date);
  console.log(JSON.stringify(result));
  if (result.status === "error") throw new Error(result.message);
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
