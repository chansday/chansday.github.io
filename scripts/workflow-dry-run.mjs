import { MODES, run } from "./update-results.mjs";

for (const mode of Object.keys(MODES)) {
  await run(["--mode", mode, "--dry-run"]);
}
