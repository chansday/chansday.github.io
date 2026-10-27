import { MODES, run } from "./update-results.mjs";
import { resolveStage } from "./run-context.mjs";

const args = process.argv.slice(2);
const autoStage = args.includes("--auto-stage");
const passthroughArgs = args.filter((arg) => arg !== "--auto-stage");
if (autoStage) {
  const startedAtIndex = passthroughArgs.indexOf("--run-started-at");
  const startedAt = startedAtIndex >= 0 ? passthroughArgs[startedAtIndex + 1] : process.env.KOSPI_RUN_STARTED_AT;
  if (!startedAt) throw new Error("--auto-stage requires --run-started-at ISO or KOSPI_RUN_STARTED_AT.");
  const context = resolveStage(startedAt);
  const contextArgs = passthroughArgs.filter((arg, index) => arg !== "--run-started-at" && index !== startedAtIndex + 1);
  await run(["--mode", context.stage, "--run-started-at", context.referenceTime, ...contextArgs, "--dry-run"]);
} else {
  for (const mode of Object.keys(MODES)) {
    await run(["--mode", mode, ...passthroughArgs, "--dry-run"]);
  }
}
