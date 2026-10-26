import { MODES, run } from "./update-results.mjs";

const passthroughArgs = process.argv.slice(2);
for (const mode of Object.keys(MODES)) {
  await run(["--mode", mode, ...passthroughArgs, "--dry-run"]);
}
